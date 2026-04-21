"""Dagster ops wrapping the Rust ``ingest`` CLI.

Each op has a matching ``Config`` class and a pure ``*_to_args`` translator
so the CLI construction can be unit-tested without a Dagster harness.

Note: this module deliberately does **not** use ``from __future__ import
annotations`` — Dagster's Pythonic config schema inference evaluates config
class annotations at op-decoration time and needs the real runtime types.
"""

from typing import Optional

from dagster import Config, OpExecutionContext, op

from etl.resources.rust_ingest import RustIngestResource


VALID_SOURCES = {"etherscan", "alchemy", "mock"}
REPROCESS_SOURCES = {"etherscan", "alchemy"}


# ---------------------------------------------------------------------------
# Config classes
# ---------------------------------------------------------------------------


class BackfillConfig(Config):
    """Configuration for ``ingest block --start N --end M``."""

    start: int
    end: int
    with_traces: bool = False
    with_transfers: bool = False
    source: Optional[str] = None  # one of VALID_SOURCES; None = infer


class ReprocessConfig(Config):
    """Configuration for ``ingest reprocess-failed --source S``."""

    source: str  # must be in REPROCESS_SOURCES


class TargetedAddressesConfig(Config):
    """Configuration for ``ingest targeted addresses --addrs ...``."""

    addresses: list[str]
    with_traces: bool = False
    with_transfers: bool = False


class TargetedNeighborhoodConfig(Config):
    """Configuration for ``ingest targeted neighborhood <seed> --hops N``."""

    seed: str
    hops: int = 1


class TargetedDrainConfig(Config):
    """Configuration for ``ingest targeted from-label-tasks --limit N``."""

    limit: int = 50


# ---------------------------------------------------------------------------
# Pure config → CLI args translators (unit-testable)
# ---------------------------------------------------------------------------


def backfill_to_args(cfg: BackfillConfig) -> list[str]:
    if cfg.source is not None and cfg.source not in VALID_SOURCES:
        raise ValueError(
            f"BackfillConfig.source must be one of {sorted(VALID_SOURCES)}, got {cfg.source!r}"
        )
    args: list[str] = ["block", "--start", str(cfg.start), "--end", str(cfg.end)]
    if cfg.with_traces:
        args.append("--with-traces")
    if cfg.with_transfers:
        args.append("--with-transfers")
    return args


def reprocess_to_args(cfg: ReprocessConfig) -> list[str]:
    if cfg.source not in REPROCESS_SOURCES:
        raise ValueError(
            f"ReprocessConfig.source must be one of {sorted(REPROCESS_SOURCES)}, got {cfg.source!r}"
        )
    return ["reprocess-failed", "--source", cfg.source]


def targeted_addresses_to_args(cfg: TargetedAddressesConfig) -> list[str]:
    if not cfg.addresses:
        raise ValueError("TargetedAddressesConfig.addresses must not be empty")
    args = ["targeted", "addresses", "--addrs", ",".join(cfg.addresses)]
    if cfg.with_traces:
        args.append("--with-traces")
    if cfg.with_transfers:
        args.append("--with-transfers")
    return args


def targeted_neighborhood_to_args(cfg: TargetedNeighborhoodConfig) -> list[str]:
    return ["targeted", "neighborhood", cfg.seed, "--hops", str(cfg.hops)]


def targeted_drain_to_args(cfg: TargetedDrainConfig) -> list[str]:
    return ["targeted", "from-label-tasks", "--limit", str(cfg.limit)]


# ---------------------------------------------------------------------------
# Ops — translate config, call resource. `source` override passed as env var.
# ---------------------------------------------------------------------------


def _env_from_source(source: Optional[str]) -> Optional[dict]:
    return {"INGEST_SOURCE": source} if source else None


@op
def backfill_op(
    context: OpExecutionContext,
    config: BackfillConfig,
    rust_ingest: RustIngestResource,
) -> None:
    rust_ingest.run(
        context,
        backfill_to_args(config),
        env=_env_from_source(config.source),
    )


@op
def reprocess_op(
    context: OpExecutionContext,
    config: ReprocessConfig,
    rust_ingest: RustIngestResource,
) -> None:
    rust_ingest.run(context, reprocess_to_args(config))


@op
def targeted_addresses_op(
    context: OpExecutionContext,
    config: TargetedAddressesConfig,
    rust_ingest: RustIngestResource,
) -> None:
    rust_ingest.run(context, targeted_addresses_to_args(config))


@op
def targeted_neighborhood_op(
    context: OpExecutionContext,
    config: TargetedNeighborhoodConfig,
    rust_ingest: RustIngestResource,
) -> None:
    rust_ingest.run(context, targeted_neighborhood_to_args(config))


@op
def targeted_drain_op(
    context: OpExecutionContext,
    config: TargetedDrainConfig,
    rust_ingest: RustIngestResource,
) -> None:
    rust_ingest.run(context, targeted_drain_to_args(config))
