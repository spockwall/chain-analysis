"""Unit tests for Dagster op config → CLI arg translation.

These cover the pure functions in ``etl.ops.ingest`` so we don't need a
Dagster harness or the Rust binary to exercise the mapping.
"""

from __future__ import annotations

import pytest

from etl.ops.ingest import (
    BackfillConfig,
    ReprocessConfig,
    TargetedAddressesConfig,
    TargetedDrainConfig,
    TargetedNeighborhoodConfig,
    backfill_to_args,
    reprocess_to_args,
    targeted_addresses_to_args,
    targeted_drain_to_args,
    targeted_neighborhood_to_args,
)


def test_backfill_minimal() -> None:
    cfg = BackfillConfig(start=100, end=200)
    assert backfill_to_args(cfg) == ["block", "--start", "100", "--end", "200"]


def test_backfill_with_flags() -> None:
    cfg = BackfillConfig(start=1, end=5, with_traces=True, with_transfers=True)
    assert backfill_to_args(cfg) == [
        "block",
        "--start",
        "1",
        "--end",
        "5",
        "--with-traces",
        "--with-transfers",
    ]


def test_reprocess_args() -> None:
    assert reprocess_to_args(ReprocessConfig(source="etherscan")) == [
        "reprocess-failed",
        "--source",
        "etherscan",
    ]
    assert reprocess_to_args(ReprocessConfig(source="alchemy")) == [
        "reprocess-failed",
        "--source",
        "alchemy",
    ]


def test_targeted_addresses_joins_comma() -> None:
    cfg = TargetedAddressesConfig(addresses=["0xaaa", "0xbbb"], with_traces=True)
    assert targeted_addresses_to_args(cfg) == [
        "targeted",
        "addresses",
        "--addrs",
        "0xaaa,0xbbb",
        "--with-traces",
    ]


def test_targeted_addresses_empty_rejected() -> None:
    with pytest.raises(ValueError):
        targeted_addresses_to_args(TargetedAddressesConfig(addresses=[]))


def test_targeted_neighborhood_args() -> None:
    cfg = TargetedNeighborhoodConfig(seed="0xseed", hops=2)
    assert targeted_neighborhood_to_args(cfg) == [
        "targeted",
        "neighborhood",
        "0xseed",
        "--hops",
        "2",
    ]


def test_targeted_drain_args() -> None:
    assert targeted_drain_to_args(TargetedDrainConfig()) == [
        "targeted",
        "from-label-tasks",
        "--limit",
        "50",
    ]
    assert targeted_drain_to_args(TargetedDrainConfig(limit=10)) == [
        "targeted",
        "from-label-tasks",
        "--limit",
        "10",
    ]
