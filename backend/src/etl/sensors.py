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
    default_status=DefaultSensorStatus.STOPPED,
    description=(
        "Trigger `targeted_drain_job` whenever INGEST_TARGETED_QUEUE has "
        "pending entries. Cursor = last observed LLEN to debounce bursts."
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

    # Cursor dedupes so we don't re-fire when the queue is still draining
    # from the previous run. Move forward only once the previous length was
    # observed — this creates one run per "queue has work" edge.
    last_cursor = context.cursor or "0"
    cursor_value = str(length)
    if last_cursor == cursor_value:
        return SkipReason(f"Queue length unchanged at {length}; drain in flight")

    context.update_cursor(cursor_value)
    return RunRequest(
        run_key=f"drain-{cursor_value}-{context.cursor}",
        run_config=RunConfig(
            ops={"targeted_drain_op": TargetedDrainConfig(limit=DRAIN_LIMIT)},
        ),
    )
