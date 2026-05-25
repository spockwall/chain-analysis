"""Dagster schedules for Phase D orchestration."""

from __future__ import annotations

from dagster import DefaultScheduleStatus, RunConfig, ScheduleDefinition

from etl.jobs import reprocess_job
from etl.ops.ingest import ReprocessConfig


reprocess_etherscan_hourly = ScheduleDefinition(
    name="reprocess_etherscan_hourly",
    job=reprocess_job,
    cron_schedule="0 * * * *",
    default_status=DefaultScheduleStatus.STOPPED,
    run_config=RunConfig(
        ops={"reprocess_op": ReprocessConfig(source="etherscan")},
    ),
    description="Retry failed Etherscan block fetches every hour on the hour.",
)

reprocess_alchemy_hourly = ScheduleDefinition(
    name="reprocess_alchemy_hourly",
    job=reprocess_job,
    cron_schedule="15 * * * *",
    default_status=DefaultScheduleStatus.STOPPED,
    run_config=RunConfig(
        ops={"reprocess_op": ReprocessConfig(source="alchemy")},
    ),
    description="Retry failed Alchemy block fetches every hour at :15.",
)
