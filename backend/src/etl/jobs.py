"""Dagster jobs for Phase D orchestration.

Each job wraps a single op that invokes the Rust ``ingest`` binary.
"""

from __future__ import annotations

from dagster import job

from etl.ops.ingest import (
    backfill_op,
    reprocess_op,
    targeted_addresses_op,
    targeted_drain_op,
    targeted_neighborhood_op,
)


@job(description="Backfill a contiguous block range via `ingest block --start --end`.")
def backfill_job() -> None:
    backfill_op()


@job(description="Re-run previously failed block ranges recorded in Redis.")
def reprocess_job() -> None:
    reprocess_op()


@job(description="Ad-hoc fetch for an explicit address list.")
def targeted_addresses_job() -> None:
    targeted_addresses_op()


@job(description="Ad-hoc fetch of a seed address plus N-hop neighborhood.")
def targeted_neighborhood_job() -> None:
    targeted_neighborhood_op()


@job(description="Drain `INGEST_TARGETED_QUEUE` populated by the backend.")
def targeted_drain_job() -> None:
    targeted_drain_op()
