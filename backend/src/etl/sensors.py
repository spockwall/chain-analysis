"""Dagster sensors for Phase D orchestration."""

from __future__ import annotations

import os

import redis
from dagster import (
    DefaultSensorStatus,
    RunConfig,
    RunRequest,
    SensorEvaluationContext,
    SkipReason,
    sensor,
)

from etl.jobs import targeted_drain_job
from etl.ops.ingest import TargetedDrainConfig


TARGETED_QUEUE = os.getenv("INGEST_TARGETED_QUEUE", "ingest:targeted_queue")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
SENSOR_MIN_INTERVAL_SECONDS = int(os.getenv("DAGSTER_TARGETED_SENSOR_INTERVAL", "30"))
DRAIN_LIMIT = int(os.getenv("DAGSTER_TARGETED_DRAIN_LIMIT", "50"))


@sensor(
    job=targeted_drain_job,
    minimum_interval_seconds=SENSOR_MIN_INTERVAL_SECONDS,
    default_status=DefaultSensorStatus.RUNNING,
    description=(
        "Trigger `targeted_drain_job` whenever INGEST_TARGETED_QUEUE has "
        "pending entries. Each tick increments an internal counter used as "
        "the run_key so overlapping/failed drains don't starve future work."
    ),
)
def targeted_queue_sensor(context: SensorEvaluationContext):
    client = redis.from_url(REDIS_URL)
    try:
        length = client.llen(TARGETED_QUEUE)
    finally:
        client.close()

    if length == 0:
        return SkipReason(f"{TARGETED_QUEUE} is empty")

    # Monotonic tick counter as run_key. Incrementing per non-empty observation
    # gives Dagster a unique key each time so a prior failure doesn't block
    # future runs, but each individual RunRequest is still idempotent under
    # Dagster's own run_key dedup (retries within the same tick are safe).
    tick = int(context.cursor or "0") + 1
    context.update_cursor(str(tick))
    return RunRequest(
        run_key=f"drain-{tick}",
        run_config=RunConfig(
            ops={"targeted_drain_op": TargetedDrainConfig(limit=DRAIN_LIMIT)},
        ),
    )
