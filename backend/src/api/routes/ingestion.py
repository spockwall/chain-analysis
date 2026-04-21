"""Ingestion runs API endpoints.

Provides read-only endpoints for the ingestion_runs PostgreSQL table,
which tracks ETL pipeline execution history.
"""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from api.deps import RelationalDBDep

router = APIRouter(prefix="/ingestion-runs", tags=["ingestion-runs"])


class IngestionRunResponse(BaseModel):
    """Response model for a single ingestion run."""

    id: int
    run_id: str
    chain_id: int
    start_block: int
    end_block: int
    data_source: str
    status: str
    error_message: str | None = None
    transactions_processed: int = 0
    traces_processed: int = 0
    nodes_created: int = 0
    edges_created: int = 0
    started_at: datetime | None = None
    completed_at: datetime | None = None
    dagster_run_id: str | None = None


def _row_to_response(row: dict) -> IngestionRunResponse:
    return IngestionRunResponse(
        id=row["id"],
        run_id=row["run_id"],
        chain_id=row.get("chain_id", 1),
        start_block=row.get("start_block", 0),
        end_block=row.get("end_block", 0),
        data_source=row.get("data_source", ""),
        status=row.get("status", "running"),
        error_message=row.get("error_message"),
        transactions_processed=row.get("transactions_processed", 0),
        traces_processed=row.get("traces_processed", 0),
        nodes_created=row.get("nodes_created", 0),
        edges_created=row.get("edges_created", 0),
        started_at=row.get("started_at"),
        completed_at=row.get("completed_at"),
        dagster_run_id=row.get("dagster_run_id"),
    )


@router.get("", response_model=list[IngestionRunResponse])
async def list_ingestion_runs(
    db: RelationalDBDep,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[IngestionRunResponse]:
    """List user-triggered ingestion runs, newest first.

    Excludes `rust-process` rows — those are the long-running stream consumer's
    lifetime markers (inserted at startup, updated on graceful exit) and would
    otherwise appear stuck at `running` in the UI for the lifetime of the
    container.
    """
    rows = await db.execute(
        "SELECT * FROM ingestion_runs "
        "WHERE data_source <> 'rust-process' "
        "ORDER BY started_at DESC LIMIT :limit OFFSET :offset",
        {"limit": limit, "offset": offset},
    )
    return [_row_to_response(row) for row in rows]


@router.get("/{run_id}", response_model=IngestionRunResponse)
async def get_ingestion_run(
    run_id: str,
    db: RelationalDBDep,
) -> IngestionRunResponse:
    """Get a single ingestion run by run_id."""
    rows = await db.execute(
        "SELECT * FROM ingestion_runs WHERE run_id = :run_id",
        {"run_id": run_id},
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"Ingestion run {run_id} not found")
    return _row_to_response(rows[0])
