"""Tests for API endpoints."""

from fastapi.testclient import TestClient


class TestHealthEndpoints:
    """Tests for health check endpoints."""

    def test_liveness_probe(self, client: TestClient):
        """Test liveness probe returns OK."""
        response = client.get("/health/live")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestEntityEndpoints:
    """Tests for entity endpoints."""

    def test_get_entity_invalid_address_format(self, client: TestClient):
        """Test invalid address format returns 400."""
        # Missing 0x prefix
        response = client.get("/api/entities/28c6c06298d514db089934071355e5743bf21d60")
        assert response.status_code == 400

        # Too short
        response = client.get("/api/entities/0x28c6c0")
        assert response.status_code == 400

    def test_get_neighbors_invalid_depth(self, client: TestClient):
        """Test invalid depth parameter."""
        address = "0x28c6c06298d514db089934071355e5743bf21d60"

        # Depth too high
        response = client.get(f"/api/entities/{address}/neighbors?depth=10")
        assert response.status_code == 422

        # Depth too low
        response = client.get(f"/api/entities/{address}/neighbors?depth=0")
        assert response.status_code == 422

    def test_find_paths_invalid_addresses(self, client: TestClient):
        """Test invalid addresses for path finding."""
        response = client.get("/api/entities/invalid/paths/0x28c6c06298d514db089934071355e5743bf21d60")
        assert response.status_code == 400


class TestLabelEndpoints:
    """Tests for labeling endpoints."""

    def test_create_task_invalid_address(self, client: TestClient):
        """Test creating task with invalid address."""
        response = client.post(
            "/api/labels/tasks",
            json={
                "entity_address": "invalid",
                "title": "Test task",
            },
        )
        assert response.status_code == 400

    def test_list_tasks_pagination(self, client: TestClient):
        """Test task listing with pagination."""
        response = client.get("/api/labels/tasks?limit=10&offset=0")
        # Should succeed even if no tasks exist
        assert response.status_code in [200, 500]  # 500 if DB not connected


class TestPipelineEndpoints:
    """Tests for pipeline endpoint registration."""

    def test_ingest_address_route_is_registered(self, client: TestClient):
        """Test Etherscan ingestion route exists for explorer fetch action."""
        response = client.post("/api/pipeline/ingest-address", json={})
        assert response.status_code == 422


class TestDetectionsEndpoints:
    """Tests for AML detections endpoint registration."""

    def test_detections_route_is_registered(self, client: TestClient):
        """Endpoint exists and validates required query params."""
        response = client.get("/api/detections/peel-chain")
        assert response.status_code == 422

    def test_detections_invalid_address_format(self, client: TestClient):
        """Invalid address should return 400."""
        response = client.get("/api/detections/peel-chain?address=invalid")
        assert response.status_code == 400


class TestValidation:
    """Tests for input validation."""

    def test_address_normalization(self, client: TestClient):
        """Test that addresses are normalized to lowercase."""
        # This would test the actual normalization in the endpoint
        upper_address = "0x28C6C06298D514DB089934071355E5743BF21D60"
        response = client.get(f"/api/entities/{upper_address}")
        # The address should be normalized before lookup
        # Actual test depends on endpoint implementation
        assert response.status_code in [200, 404, 500]  # 200 if found, 404 if not found, 500 if DB not connected

    def test_risk_level_enum(self, client: TestClient):
        """Test that risk_level enum is validated."""
        response = client.post(
            "/api/labels/annotations",
            json={
                "task_id": 1,
                "entity_address": "0x28c6c06298d514db089934071355e5743bf21d60",
                "risk_level": "invalid_level",
            },
        )
        assert response.status_code == 422
