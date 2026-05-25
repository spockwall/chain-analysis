"""Dagster definitions for chain-analysis ETL orchestration.

Phase I: the targeted-queue sensor + drain job are gone — the Rust worker
now consumes `ingest:targeted_queue` directly. Dagster remains as a cold
harness for manual backfills and scheduled reprocess jobs.

Run with::

    dagster dev -m etl.definitions
"""

from __future__ import annotations

from dagster import Definitions

from etl.jobs import (
    backfill_job,
    reprocess_job,
    targeted_addresses_job,
    targeted_neighborhood_job,
)
from etl.resources import RustIngestResource
from etl.schedules import reprocess_alchemy_hourly, reprocess_etherscan_hourly


defs = Definitions(
    jobs=[
        backfill_job,
        reprocess_job,
        targeted_addresses_job,
        targeted_neighborhood_job,
    ],
    schedules=[reprocess_etherscan_hourly, reprocess_alchemy_hourly],
    resources={
        "rust_ingest": RustIngestResource(),
    },
)
