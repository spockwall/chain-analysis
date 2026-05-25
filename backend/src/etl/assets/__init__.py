"""Dagster assets for the ETL pipeline.

Asset-based definitions were removed in Phase D — the Rust workers own the
ingest → stream → graph/OLAP pipeline end-to-end. Dagster now orchestrates
jobs/sensors/schedules only (see ``etl.jobs``, ``etl.sensors``, ``etl.schedules``).
"""

__all__: list[str] = []
