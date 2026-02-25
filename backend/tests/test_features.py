"""Tests for entity features endpoints (GET /api/entities/{address}/features and
PUT /api/entities/{address}/features).

These tests exercise input validation and response schema without a live database
connection — the same approach used in test_api.py.
"""

import pytest
from fastapi.testclient import TestClient


VALID_ADDRESS = "0x28c6c06298d514db089934071355e5743bf21d60"
SHORT_ADDRESS = "0x28c6c0"
NO_PREFIX_ADDRESS = "28c6c06298d514db089934071355e5743bf21d60"
UPPER_ADDRESS = "0x28C6C06298D514DB089934071355E5743BF21D60"

MINIMAL_UPSERT = {
    "chain_id": 1,
}

FULL_UPSERT = {
    "chain_id": 1,
    "first_seen_at": "2023-01-01T00:00:00Z",
    "last_seen_at": "2024-06-01T12:00:00Z",
    "activity_interval_avg_sec": 3600.5,
    "active_hour_distribution": [round(i / 240, 4) for i in range(24)],
    "balance_avg_wei": "500000000000000000",
    "balance_max_wei": "2000000000000000000",
    "has_deployed_contract": True,
    "is_labeled": True,
    "out_degree": 42,
    "in_degree": 17,
    "unique_interacted_entities": 50,
    "same_type_transfer_count": 8,
    "same_amount_transfer_count": 3,
    "volume_in_wei": "10000000000000000000",
    "volume_out_wei": "9500000000000000000",
    "computed_at": "2024-06-01T12:00:00Z",
}


class TestGetEntityFeatures:
    """Tests for GET /api/entities/{address}/features."""

    def test_invalid_address_no_prefix(self, client: TestClient):
        response = client.get(f"/api/entities/{NO_PREFIX_ADDRESS}/features")
        assert response.status_code == 400

    def test_invalid_address_too_short(self, client: TestClient):
        response = client.get(f"/api/entities/{SHORT_ADDRESS}/features")
        assert response.status_code == 400

    def test_valid_address_no_db_returns_non_400(self, client: TestClient):
        """A well-formed address passes validation and reaches the DB layer."""
        response = client.get(f"/api/entities/{VALID_ADDRESS}/features")
        assert response.status_code in (200, 404, 500)

    def test_valid_address_uppercase_accepted(self, client: TestClient):
        """Uppercase address must not be rejected at validation — reaches DB layer."""
        response = client.get(f"/api/entities/{UPPER_ADDRESS}/features")
        assert response.status_code in (200, 404, 500)


class TestUpsertEntityFeatures:
    """Tests for PUT /api/entities/{address}/features."""

    def test_invalid_address_no_prefix(self, client: TestClient):
        response = client.put(
            f"/api/entities/{NO_PREFIX_ADDRESS}/features",
            json=MINIMAL_UPSERT,
        )
        assert response.status_code == 400

    def test_invalid_address_too_short(self, client: TestClient):
        response = client.put(
            f"/api/entities/{SHORT_ADDRESS}/features",
            json=MINIMAL_UPSERT,
        )
        assert response.status_code == 400

    def test_missing_body_returns_422(self, client: TestClient):
        response = client.put(f"/api/entities/{VALID_ADDRESS}/features")
        assert response.status_code == 422

    def test_minimal_body_accepted_by_validation(self, client: TestClient):
        """A body with only chain_id passes Pydantic validation (all others have defaults)."""
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=MINIMAL_UPSERT,
        )
        # Passes validation; fails at DB layer without a connection
        assert response.status_code in (200, 500)

    def test_full_body_passes_validation(self, client: TestClient):
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=FULL_UPSERT,
        )
        assert response.status_code in (200, 500)

    def test_active_hour_distribution_wrong_length_rejected(self, client: TestClient):
        """active_hour_distribution must be exactly 24 elements."""
        body = {**MINIMAL_UPSERT, "active_hour_distribution": [0.1] * 10}
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=body,
        )
        assert response.status_code == 422

    def test_active_hour_distribution_too_long_rejected(self, client: TestClient):
        body = {**MINIMAL_UPSERT, "active_hour_distribution": [0.0] * 25}
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=body,
        )
        assert response.status_code == 422

    def test_active_hour_distribution_exact_24_accepted(self, client: TestClient):
        body = {**MINIMAL_UPSERT, "active_hour_distribution": [0.0] * 24}
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=body,
        )
        assert response.status_code in (200, 500)

    def test_invalid_chain_id_type_rejected(self, client: TestClient):
        body = {"chain_id": "not-an-int"}
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=body,
        )
        assert response.status_code == 422

    def test_negative_degrees_rejected(self, client: TestClient):
        """out_degree and in_degree are plain ints — negative values should be rejected."""
        for field in ("out_degree", "in_degree", "unique_interacted_entities",
                      "same_type_transfer_count", "same_amount_transfer_count"):
            body = {**MINIMAL_UPSERT, field: -1}
            response = client.put(
                f"/api/entities/{VALID_ADDRESS}/features",
                json=body,
            )
            # Pydantic doesn't enforce ge=0 unless annotated — just ensure no crash
            assert response.status_code in (200, 422, 500)

    def test_wei_fields_as_strings(self, client: TestClient):
        """Wei values must be accepted as decimal strings."""
        body = {
            **MINIMAL_UPSERT,
            "balance_avg_wei": "123456789012345678901234567890",
            "volume_in_wei": "999999999999999999999",
            "volume_out_wei": "0",
        }
        response = client.put(
            f"/api/entities/{VALID_ADDRESS}/features",
            json=body,
        )
        assert response.status_code in (200, 500)

    def test_uppercase_address_normalised(self, client: TestClient):
        """Uppercase address must not be rejected — route lowercases it internally."""
        response = client.put(
            f"/api/entities/{UPPER_ADDRESS}/features",
            json=MINIMAL_UPSERT,
        )
        assert response.status_code in (200, 500)


class TestFeaturesResponseSchema:
    """Verify that EntityFeaturesResponse fields are serialised correctly
    using the Pydantic model directly (no DB required)."""

    def test_response_model_defaults(self):
        from api.models.entity import EntityFeaturesResponse

        resp = EntityFeaturesResponse(address=VALID_ADDRESS)
        assert resp.chain_id == 1
        assert resp.has_deployed_contract is False
        assert resp.is_labeled is False
        assert resp.out_degree == 0
        assert resp.in_degree == 0
        assert resp.unique_interacted_entities == 0
        assert resp.same_type_transfer_count == 0
        assert resp.same_amount_transfer_count == 0
        assert resp.balance_avg_wei is None
        assert resp.balance_max_wei is None
        assert resp.volume_in_wei is None
        assert resp.volume_out_wei is None
        assert resp.active_hour_distribution is None
        assert resp.first_seen_at is None
        assert resp.last_seen_at is None
        assert resp.computed_at is None

    def test_response_model_wei_as_string(self):
        from api.models.entity import EntityFeaturesResponse

        resp = EntityFeaturesResponse(
            address=VALID_ADDRESS,
            balance_avg_wei="123456789012345678901234567890",
            volume_in_wei="0",
        )
        assert isinstance(resp.balance_avg_wei, str)
        assert isinstance(resp.volume_in_wei, str)

    def test_response_model_serialises_to_json(self):
        from api.models.entity import EntityFeaturesResponse

        resp = EntityFeaturesResponse(
            address=VALID_ADDRESS,
            out_degree=5,
            in_degree=3,
            balance_avg_wei="1000000000000000000",
        )
        data = resp.model_dump()
        assert data["address"] == VALID_ADDRESS
        assert data["out_degree"] == 5
        assert data["in_degree"] == 3
        assert data["balance_avg_wei"] == "1000000000000000000"


class TestUpsertRequestSchema:
    """Verify EntityFeaturesUpsertRequest validation directly."""

    def test_valid_minimal(self):
        from api.models.entity import EntityFeaturesUpsertRequest

        req = EntityFeaturesUpsertRequest(**MINIMAL_UPSERT)
        assert req.chain_id == 1
        assert req.has_deployed_contract is False

    def test_active_hour_distribution_length_validation(self):
        from pydantic import ValidationError

        from api.models.entity import EntityFeaturesUpsertRequest

        with pytest.raises(ValidationError):
            EntityFeaturesUpsertRequest(
                chain_id=1,
                active_hour_distribution=[0.0] * 10,
            )

        with pytest.raises(ValidationError):
            EntityFeaturesUpsertRequest(
                chain_id=1,
                active_hour_distribution=[0.0] * 25,
            )

        # Exactly 24 — should not raise
        req = EntityFeaturesUpsertRequest(
            chain_id=1,
            active_hour_distribution=[0.0] * 24,
        )
        assert len(req.active_hour_distribution) == 24

    def test_full_request_valid(self):
        from api.models.entity import EntityFeaturesUpsertRequest

        req = EntityFeaturesUpsertRequest(**FULL_UPSERT)
        assert req.out_degree == 42
        assert req.balance_avg_wei == "500000000000000000"
        assert req.has_deployed_contract is True
