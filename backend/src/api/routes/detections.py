"""AML detections API endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from neo4j.graph import Node as Neo4jNode
from neo4j.graph import Path as Neo4jPath

from api.deps import GraphDBDep
from api.models.entity import (
    DetectionPattern,
    DetectionsResponse,
    EntityResponse,
    RiskLevel,
    TransactionResponse,
)
from graph.queries import AMLPatternQueries

router = APIRouter(prefix="/detections", tags=["detections"])


def _validate_address(address: str) -> str:
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")
    return address.lower()


def _tx_to_response(tx: dict[str, Any]) -> TransactionResponse:
    return TransactionResponse(
        hash=tx.get("hash", ""),
        from_address=tx.get("from_address", ""),
        to_address=tx.get("to_address", ""),
        value=tx.get("value"),
        block_number=tx.get("block_number"),
        timestamp=tx.get("timestamp"),
        gas_used=tx.get("gas_used"),
        gas_price=tx.get("gas_price"),
        properties={
            k: v
            for k, v in tx.items()
            if k
            not in {
                "hash",
                "from_address",
                "to_address",
                "value",
                "block_number",
                "timestamp",
                "gas_used",
                "gas_price",
            }
        },
    )


def _entity_to_response(node: dict[str, Any]) -> EntityResponse:
    risk_raw = str(node.get("risk_level", "unknown")).lower()
    if risk_raw not in {"unknown", "low", "medium", "high", "critical"}:
        risk_raw = "unknown"

    props = {
        k: v
        for k, v in node.items()
        if k
        not in {
            "address",
            "entity_type",
            "risk_level",
            "name",
            "labels",
            "first_seen_block",
            "last_seen_block",
            "transaction_count",
            "member_count",
        }
    }

    return EntityResponse(
        address=node.get("address", ""),
        entity_type=node.get("entity_type"),
        risk_level=RiskLevel(risk_raw),
        name=node.get("name"),
        labels=list(node.get("labels", [])),
        first_seen_block=node.get("first_seen_block"),
        last_seen_block=node.get("last_seen_block"),
        transaction_count=node.get("transaction_count"),
        member_count=int(node.get("member_count", 0) or 0),
        properties=props,
    )


def _collect_from_value(
    value: Any,
    entities: dict[str, dict[str, Any]],
    txs: dict[str, dict[str, Any]],
) -> None:
    if value is None:
        return

    if isinstance(value, Neo4jPath):
        for node in value.nodes:
            _collect_from_value(node, entities, txs)
        return

    if isinstance(value, Neo4jNode):
        labels = set(value.labels)
        data = dict(value)
        if "Transaction" in labels:
            tx_hash = data.get("hash")
            if tx_hash:
                txs[tx_hash] = {
                    "hash": tx_hash,
                    "from_address": data.get("from_address", ""),
                    "to_address": data.get("to_address", ""),
                    "value": data.get("value"),
                    "block_number": data.get("block_number"),
                    "timestamp": data.get("timestamp"),
                    "gas_used": data.get("gas_used"),
                    "gas_price": data.get("gas_price"),
                }
        elif "Entity" in labels or data.get("address"):
            address = data.get("address")
            if address:
                entities[address] = {
                    "address": address,
                    "entity_type": data.get("entity_type"),
                    "risk_level": data.get("risk_level", "unknown"),
                    "name": data.get("name"),
                    "labels": [l for l in labels if l != "Entity"],
                    "first_seen_block": data.get("first_seen_block"),
                    "last_seen_block": data.get("last_seen_block"),
                    "transaction_count": data.get("tx_count"),
                    "member_count": data.get("member_count", 0),
                }
        return

    if isinstance(value, dict):
        if {"hash", "from_address", "to_address"}.issubset(value.keys()):
            tx_hash = value.get("hash")
            if tx_hash:
                txs[tx_hash] = {
                    "hash": tx_hash,
                    "from_address": value.get("from_address", ""),
                    "to_address": value.get("to_address", ""),
                    "value": value.get("value"),
                    "block_number": value.get("block") or value.get("block_number"),
                    "timestamp": value.get("timestamp"),
                }
        if "address" in value and isinstance(value["address"], str):
            entities[value["address"]] = {
                "address": value["address"],
                "entity_type": value.get("entity_type"),
                "risk_level": value.get("risk_level", "unknown"),
                "name": value.get("name"),
                "labels": list(value.get("labels", [])),
                "member_count": value.get("member_count", 0),
            }

        for nested in value.values():
            _collect_from_value(nested, entities, txs)
        return

    if isinstance(value, (list, tuple, set)):
        for item in value:
            _collect_from_value(item, entities, txs)


@router.get("/{pattern}", response_model=DetectionsResponse)
async def detect_pattern(
    pattern: DetectionPattern,
    address: str,
    graph_db: GraphDBDep,
    limit: int = Query(20, ge=1, le=200, description="Maximum matches to return"),
) -> DetectionsResponse:
    """Run an AML detection pattern for a target address."""
    target = _validate_address(address)

    if pattern == DetectionPattern.PEEL_CHAIN:
        query_result = AMLPatternQueries.detect_peel_chain(target, min_chain_length=3)
    elif pattern == DetectionPattern.STRUCTURING:
        query_result = AMLPatternQueries.detect_structuring(target)
    elif pattern == DetectionPattern.ROUND_TRIP:
        query_result = AMLPatternQueries.detect_round_trip(target, max_hops=5, limit=limit)
    elif pattern == DetectionPattern.FAN_OUT_FAN_IN:
        query_result = AMLPatternQueries.detect_fan_out_fan_in(target)
    elif pattern == DetectionPattern.MIXER_INTERACTION:
        query_result = AMLPatternQueries.detect_mixer_interaction(target)
    else:
        raise HTTPException(status_code=404, detail="Unknown detection pattern")

    records = await graph_db.execute_query(query_result.query, query_result.params)

    entities: dict[str, dict[str, Any]] = {
        target: {
            "address": target,
            "risk_level": "unknown",
            "labels": [],
            "member_count": 0,
        }
    }
    txs: dict[str, dict[str, Any]] = {}

    for record in records:
        _collect_from_value(record, entities, txs)

    nodes = [_entity_to_response(item) for item in entities.values()]
    transactions = [_tx_to_response(item) for item in txs.values() if item.get("hash")]

    return DetectionsResponse(
        pattern=pattern,
        address=target,
        matches=len(records),
        nodes=nodes,
        transactions=transactions,
        highlighted_node_ids=[n.address for n in nodes],
        highlighted_edge_ids=[f"tx-{t.hash}" for t in transactions],
        truncated=pattern in {DetectionPattern.ROUND_TRIP} and len(records) >= limit,
    )
