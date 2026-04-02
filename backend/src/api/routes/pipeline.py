"""Pipeline API — web-triggered address ingestion via Etherscan.

Fetches an address's transactions from Etherscan, writes entities and
transactions to Neo4j, computes basic features, and persists them to PostgreSQL.
"""

import time
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from api.deps import GraphDBDep, RelationalDBDep, SettingsDep
from core.ports.graph_db import Node, Transaction
from libs import logger

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

ETHERSCAN_BASE = "https://api.etherscan.io/v2/api"


class IngestAddressRequest(BaseModel):
    address: str
    chain_id: int = 1


class IngestAddressResponse(BaseModel):
    address: str
    run_id: str
    transactions_fetched: int
    internal_transactions_fetched: int
    entities_created: int
    transactions_created: int
    features_computed: bool
    duration_seconds: float


def _validate_address(address: str) -> str:
    addr = address.strip().lower()
    if not addr.startswith("0x") or len(addr) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format — must be 0x + 40 hex chars")
    return addr


async def _etherscan_fetch(
    client: httpx.AsyncClient,
    api_key: str,
    address: str,
    action: str,
    chain_id: int = 1,
) -> list[dict]:
    """Fetch a page of results from Etherscan API v2."""
    params = {
        "chainid": str(chain_id),
        "module": "account",
        "action": action,
        "address": address,
        "startblock": "0",
        "endblock": "99999999",
        "page": "1",
        "offset": "200",
        "sort": "desc",
        "apikey": api_key,
    }
    resp = await client.get(ETHERSCAN_BASE, params=params, timeout=30.0)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != "1":
        # status "0" with "No transactions found" is not an error
        msg = data.get("message", "")
        if "No transactions found" in msg or "No records found" in msg:
            return []
        raise HTTPException(
            status_code=502,
            detail=f"Etherscan API error ({action}): {data.get('message', 'unknown')} — {data.get('result', '')}",
        )

    return data.get("result", [])


def _build_nodes(normal_txs: list[dict], internal_txs: list[dict], target: str) -> list[Node]:
    """Collect unique addresses from all transactions and return Node list."""
    addresses: set[str] = {target}
    for tx in normal_txs:
        if tx.get("from"):
            addresses.add(tx["from"].lower())
        if tx.get("to"):
            addresses.add(tx["to"].lower())
    for tx in internal_txs:
        if tx.get("from"):
            addresses.add(tx["from"].lower())
        if tx.get("to"):
            addresses.add(tx["to"].lower())

    # Remove empty strings
    addresses.discard("")

    return [Node(address=addr, labels=["EOA"]) for addr in addresses]


def _build_transactions(normal_txs: list[dict]) -> list[Transaction]:
    """Convert Etherscan txlist results to Transaction dataclasses."""
    txs: list[Transaction] = []
    seen: set[str] = set()
    for raw in normal_txs:
        tx_hash = raw.get("hash", "")
        if not tx_hash or tx_hash in seen:
            continue
        seen.add(tx_hash)

        from_addr = (raw.get("from") or "").lower()
        to_addr = (raw.get("to") or "").lower()
        if not from_addr or not to_addr:
            continue

        props: dict = {}
        if raw.get("value"):
            props["value"] = raw["value"]
        if raw.get("blockNumber"):
            try:
                props["block_number"] = int(raw["blockNumber"])
            except (ValueError, TypeError):
                pass
        if raw.get("timeStamp"):
            try:
                props["timestamp"] = int(raw["timeStamp"])
            except (ValueError, TypeError):
                pass
        if raw.get("gasUsed"):
            try:
                props["gas_used"] = int(raw["gasUsed"])
            except (ValueError, TypeError):
                pass
        if raw.get("gasPrice"):
            props["gas_price"] = raw["gasPrice"]

        txs.append(Transaction(
            hash=tx_hash,
            from_address=from_addr,
            to_address=to_addr,
            properties=props,
        ))
    return txs


def _compute_features(
    address: str, transactions: list[Transaction], chain_id: int,
) -> dict:
    """Compute basic entity features from transaction list."""
    out_degree = 0
    in_degree = 0
    volume_in = 0
    volume_out = 0
    counterparties: set[str] = set()
    timestamps: list[int] = []

    for tx in transactions:
        ts = tx.properties.get("timestamp")
        if ts is not None:
            timestamps.append(int(ts))

        value = int(tx.properties.get("value", "0") or "0")

        if tx.from_address == address:
            out_degree += 1
            volume_out += value
            if tx.to_address:
                counterparties.add(tx.to_address)
        if tx.to_address == address:
            in_degree += 1
            volume_in += value
            if tx.from_address:
                counterparties.add(tx.from_address)

    first_seen = datetime.fromtimestamp(min(timestamps), tz=timezone.utc) if timestamps else None
    last_seen = datetime.fromtimestamp(max(timestamps), tz=timezone.utc) if timestamps else None

    return {
        "address": address,
        "chain_id": chain_id,
        "out_degree": out_degree,
        "in_degree": in_degree,
        "volume_in_wei": Decimal(str(volume_in)),
        "volume_out_wei": Decimal(str(volume_out)),
        "unique_interacted_entities": len(counterparties),
        "is_labeled": False,
        "first_seen_at": first_seen,
        "last_seen_at": last_seen,
    }


@router.post("/ingest-address", response_model=IngestAddressResponse)
async def ingest_address(
    body: IngestAddressRequest,
    settings: SettingsDep,
    graph_db: GraphDBDep,
    db: RelationalDBDep,
) -> IngestAddressResponse:
    """Fetch an address's transactions from Etherscan and ingest into Neo4j + PostgreSQL."""
    t0 = time.monotonic()
    address = _validate_address(body.address)

    if not settings.etherscan_api_key:
        raise HTTPException(status_code=400, detail="ETHERSCAN_API_KEY not configured on server")

    run_id = uuid4().hex[:12]

    # Record ingestion run as "running"
    await db.execute(
        "INSERT INTO ingestion_runs (run_id, chain_id, start_block, end_block, data_source, status) "
        "VALUES (:run_id, :chain_id, 0, 0, 'etherscan-web', 'running'::ingestionstatus)",
        {"run_id": run_id, "chain_id": body.chain_id},
    )

    try:
        # Fetch from Etherscan
        async with httpx.AsyncClient() as client:
            normal_txs = await _etherscan_fetch(
                client, settings.etherscan_api_key, address, "txlist", body.chain_id,
            )
            internal_txs = await _etherscan_fetch(
                client, settings.etherscan_api_key, address, "txlistinternal", body.chain_id,
            )

        logger.info(
            "etherscan_fetched",
            address=address,
            normal=len(normal_txs),
            internal=len(internal_txs),
        )

        # Build graph objects
        nodes = _build_nodes(normal_txs, internal_txs, address)
        transactions = _build_transactions(normal_txs)

        # Write to Neo4j
        entities_created = await graph_db.upsert_nodes(nodes)
        transactions_created = await graph_db.upsert_transactions(transactions)

        logger.info(
            "neo4j_written",
            entities=entities_created,
            transactions=transactions_created,
        )

        # Compute + upsert entity features to PostgreSQL
        features_computed = False
        if transactions:
            feats = _compute_features(address, transactions, body.chain_id)
            upsert_sql = text("""
                INSERT INTO entity_features (
                    address, chain_id,
                    first_seen_at, last_seen_at,
                    is_labeled, out_degree, in_degree,
                    unique_interacted_entities,
                    volume_in_wei, volume_out_wei,
                    computed_at, updated_at
                ) VALUES (
                    :address, :chain_id,
                    :first_seen_at, :last_seen_at,
                    :is_labeled, :out_degree, :in_degree,
                    :unique_interacted_entities,
                    :volume_in_wei, :volume_out_wei,
                    NOW(), NOW()
                )
                ON CONFLICT (address) DO UPDATE SET
                    chain_id                   = EXCLUDED.chain_id,
                    first_seen_at              = EXCLUDED.first_seen_at,
                    last_seen_at               = EXCLUDED.last_seen_at,
                    is_labeled                 = EXCLUDED.is_labeled,
                    out_degree                 = EXCLUDED.out_degree,
                    in_degree                  = EXCLUDED.in_degree,
                    unique_interacted_entities = EXCLUDED.unique_interacted_entities,
                    volume_in_wei              = EXCLUDED.volume_in_wei,
                    volume_out_wei             = EXCLUDED.volume_out_wei,
                    computed_at                = NOW(),
                    updated_at                 = NOW()
            """)
            async with db.transaction() as session:
                await session.execute(upsert_sql, feats)
            features_computed = True

        # Compute block range from fetched txs
        blocks = [int(tx.get("blockNumber", 0)) for tx in normal_txs if tx.get("blockNumber")]
        start_block = min(blocks) if blocks else 0
        end_block = max(blocks) if blocks else 0

        # Update ingestion run to completed
        await db.execute(
            "UPDATE ingestion_runs SET status = 'completed'::ingestionstatus, "
            "start_block = :start_block, end_block = :end_block, "
            "transactions_processed = :txs, nodes_created = :nodes, "
            "completed_at = NOW() "
            "WHERE run_id = :run_id",
            {
                "run_id": run_id,
                "start_block": start_block,
                "end_block": end_block,
                "txs": len(transactions),
                "nodes": entities_created,
            },
        )

        duration = round(time.monotonic() - t0, 2)
        return IngestAddressResponse(
            address=address,
            run_id=run_id,
            transactions_fetched=len(normal_txs),
            internal_transactions_fetched=len(internal_txs),
            entities_created=entities_created,
            transactions_created=transactions_created,
            features_computed=features_computed,
            duration_seconds=duration,
        )

    except HTTPException:
        raise
    except Exception as e:
        # Update run as failed
        await db.execute(
            "UPDATE ingestion_runs SET status = 'failed'::ingestionstatus, "
            "error_message = :error, completed_at = NOW() "
            "WHERE run_id = :run_id",
            {"run_id": run_id, "error": str(e)[:500]},
        )
        logger.error("ingest_address_failed", address=address, error=str(e))
        raise HTTPException(status_code=502, detail=f"Ingestion failed: {str(e)[:200]}")
