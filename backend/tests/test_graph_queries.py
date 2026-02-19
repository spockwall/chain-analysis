"""Tests for graph query builders."""

import pytest

from src.graph.queries import AMLPatternQueries, QueryBuilder, QueryResult


class TestQueryBuilder:
    """Tests for QueryBuilder class."""

    def test_upsert_entities_query(self):
        """Test entity upsert query generation."""
        query = QueryBuilder.upsert_entities()

        assert "UNWIND $nodes" in query
        assert "MERGE" in query
        assert "Entity" in query

    def test_upsert_transfers_query(self):
        """Test transfer upsert query generation."""
        query = QueryBuilder.upsert_transfers()

        assert "UNWIND $edges" in query
        assert "MERGE" in query
        assert "TRANSFER" in query

    def test_get_entity_stats(self):
        """Test entity stats query."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = QueryBuilder.get_entity_stats(address)

        assert isinstance(result, QueryResult)
        assert result.params["address"] == address
        assert "outgoing_count" in result.query
        assert "incoming_count" in result.query


class TestAMLPatternQueries:
    """Tests for AML pattern detection queries."""

    def test_detect_peel_chain(self):
        """Test peel chain detection query."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = AMLPatternQueries.detect_peel_chain(
            start_address=address,
            min_chain_length=5,
            max_time_between_txs=3600,
        )

        assert isinstance(result, QueryResult)
        assert result.params["start_address"] == address
        assert "TRANSFER" in result.query
        assert "chain_addresses" in result.query

    def test_detect_structuring(self):
        """Test structuring detection query."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = AMLPatternQueries.detect_structuring(
            address=address,
            time_window_hours=24,
            min_transactions=5,
        )

        assert isinstance(result, QueryResult)
        assert result.params["address"] == address
        assert "transaction_count" in result.query

    def test_detect_round_trip(self):
        """Test round-trip detection query."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = AMLPatternQueries.detect_round_trip(
            address=address,
            max_hops=5,
        )

        assert isinstance(result, QueryResult)
        assert "path_addresses" in result.query
        assert "hop_count" in result.query

    def test_detect_fan_out_fan_in(self):
        """Test fan-out/fan-in detection query."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = AMLPatternQueries.detect_fan_out_fan_in(
            source_address=address,
            min_fan_out=5,
        )

        assert isinstance(result, QueryResult)
        assert "fan_out_nodes" in result.query
        assert "collector" in result.query

    def test_detect_mixer_interaction_default_mixers(self):
        """Test mixer interaction detection with default mixers."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = AMLPatternQueries.detect_mixer_interaction(address=address)

        assert isinstance(result, QueryResult)
        assert "mixers" in result.params
        assert len(result.params["mixers"]) > 0
        # Should include Tornado Cash addresses
        assert any("d90e2f925" in m for m in result.params["mixers"])

    def test_detect_mixer_interaction_custom_mixers(self):
        """Test mixer interaction detection with custom mixers."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        custom_mixers = ["0xcustommixer1", "0xcustommixer2"]
        result = AMLPatternQueries.detect_mixer_interaction(
            address=address,
            known_mixer_addresses=custom_mixers,
        )

        assert result.params["mixers"] == custom_mixers

    def test_find_high_risk_paths(self):
        """Test high-risk path finding query."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"
        result = AMLPatternQueries.find_high_risk_paths(
            source_address=address,
            max_depth=4,
        )

        assert isinstance(result, QueryResult)
        assert "high_risk_entity" in result.query
        assert "risk_level" in result.query
        assert "shortestPath" in result.query


class TestQueryResult:
    """Tests for QueryResult dataclass."""

    def test_query_result_creation(self):
        """Test QueryResult creation."""
        result = QueryResult(
            query="MATCH (n) RETURN n",
            params={"limit": 10},
        )

        assert result.query == "MATCH (n) RETURN n"
        assert result.params == {"limit": 10}

    def test_query_result_empty_params(self):
        """Test QueryResult with empty params."""
        result = QueryResult(
            query="MATCH (n) RETURN n",
            params={},
        )

        assert result.params == {}
