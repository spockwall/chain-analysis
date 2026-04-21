"""Dagster definitions for chain-analysis ETL orchestration (Phase D).

Run with::

    dagster dev -m etl.definitions
"""

from __future__ import annotations

from dagster import Definitions

from etl.jobs import (
    backfill_job,
    reprocess_job,
    targeted_addresses_job,
    targeted_drain_job,
    targeted_neighborhood_job,
)
from etl.resources import RustIngestResource
from etl.schedules import reprocess_alchemy_hourly, reprocess_etherscan_hourly
from etl.sensors import targeted_queue_sensor


defs = Definitions(
    jobs=[
        backfill_job,
        reprocess_job,
        targeted_addresses_job,
        targeted_neighborhood_job,
        targeted_drain_job,
    ],
    sensors=[targeted_queue_sensor],
    schedules=[reprocess_etherscan_hourly, reprocess_alchemy_hourly],
    resources={
        "rust_ingest": RustIngestResource(),
    },
)
