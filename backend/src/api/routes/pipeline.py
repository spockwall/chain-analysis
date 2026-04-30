"""Pipeline API — web-triggered address ingestion.

`POST /pipeline/ingest-address` is a thin wrapper: it validates the address,
records a queued `ingestion_runs` row, LPUSHes a job onto
`ingest:targeted_queue`, and returns the `run_id` immediately. The Rust
`ingest targeted from-label-tasks` worker (driven by Dagster) drains the
queue, fetches from Etherscan/Alchemy, writes Neo4j + Postgres, and updates
the run row to `completed` or `failed`.

Clients poll `GET /api/ingestion-runs/{run_id}` to observe progress.
"""

import json
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.deps import MessageQueueDep, RelationalDBDep, SettingsDep
from libs.rate_limiter import limiter
from core.config import get_settings

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


class IngestAddressRequest(BaseModel):
    address: str
    chain_id: int = 1


class IngestAddressResponse(BaseModel):
    address: str
    run_id: str
    status: str


def _validate_address(address: str) -> str:
    addr = address.strip().lower()
    if not addr.startswith("0x") or len(addr) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format — must be 0x + 40 hex chars")
    return addr


@router.post("/ingest-address", response_model=IngestAddressResponse, status_code=202)
@limiter.limit(get_settings().rate_limit_ingest)
async def ingest_address(
    body: IngestAddressRequest,
    settings: SettingsDep,
    db: RelationalDBDep,
    mq: MessageQueueDep,
) -> IngestAddressResponse:
    """Queue an address for ingestion via the Rust ingest worker.

    Returns 202 Accepted with a `run_id` the caller polls via
    `/api/ingestion-runs/{run_id}`.
    """
    address = _validate_address(body.address)

    redis_conn = getattr(mq, "redis", None)
    if redis_conn is None:
        raise HTTPException(status_code=503, detail="Message queue not available")

    run_id = uuid4().hex[:12]

    await db.execute(
        "INSERT INTO ingestion_runs (run_id, chain_id, start_block, end_block, data_source, status) "
        "VALUES (:run_id, :chain_id, 0, 0, 'etherscan-web', 'queued'::ingestionstatus)",
        {"run_id": run_id, "chain_id": body.chain_id},
    )

    queue_key = settings.ingest_targeted_queue
    spec = {"mode": "addresses", "addrs": [address]}
    await redis_conn.lpush(
        queue_key,
        json.dumps({"task_id": None, "run_id": run_id, "spec": spec}),
    )

    return IngestAddressResponse(address=address, run_id=run_id, status="queued")
