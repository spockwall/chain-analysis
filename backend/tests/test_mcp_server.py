"""Tests for the Chain-Analysis MCP server."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

import api.deps as deps
import agent_mcp.server as mcp_server
import api.main as api_main
from api.main import create_app
from core.ports.graph_db import Node


class FakeGraphDB:
    """Minimal graph adapter for MCP tool tests."""

    def __init__(self) -> None:
        self.node = Node(
            address="0x28c6c06298d514db089934071355e5743bf21d60",
            labels=["CEXHotWallet"],
            properties={
                "entity_type": "CEXHotWallet",
                "risk_level": "low",
                "name": "Binance Hot Wallet",
            },
        )
        self.upserted_nodes: list[Node] = []

    async def connect(self) -> None:  # pragma: no cover - protocol stub
        return None

    async def close(self) -> None:  # pragma: no cover - protocol stub
        return None

    async def get_node(self, address: str) -> Node | None:
        if address == self.node.address:
            return self.node
        return None

    async def upsert_nodes(self, nodes: list[Node]) -> int:
        self.upserted_nodes = nodes
        return len(nodes)


class FakeRelationalDB:
    """Minimal relational adapter for ingestion and MCP tests."""

    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, Any] | None]] = []

    async def execute(
        self,
        query: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        self.executed.append((query, params))
        if "SELECT * FROM ingestion_runs WHERE run_id" in query:
            return [
                {
                    "id": 1,
                    "run_id": params["run_id"] if params else "test-run",
                    "chain_id": 1,
                    "start_block": 0,
                    "end_block": 0,
                    "data_source": "etherscan-web",
                    "status": "queued",
                }
            ]
        return []

    def session(self):
        raise AssertionError("Test should stub token validation before opening a DB session")


class FakeRedis:
    """Capture LPUSH payloads written by queueing tools."""

    def __init__(self) -> None:
        self.items: list[tuple[str, str]] = []

    async def lpush(self, key: str, value: str) -> int:
        self.items.append((key, value))
        return len(self.items)


class FakeMessageQueue:
    """Minimal message queue adapter exposing the underlying Redis client."""

    def __init__(self) -> None:
        self.redis = FakeRedis()


def _structured_result(result: Any) -> Any:
    """Extract the structured payload returned by FastMCP `call_tool()`."""
    if isinstance(result, tuple) and len(result) == 2:
        return result[1]
    return result


def _reset_mcp_http_app(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset the singleton Streamable HTTP session manager for isolated tests."""
    mcp_server.chain_analysis_mcp._session_manager = None
    monkeypatch.setattr(
        api_main,
        "chain_analysis_mcp_http_app",
        mcp_server.AuthenticatedMCPHTTPApp(
            mcp_server.chain_analysis_mcp.streamable_http_app()
        ),
    )


@pytest.fixture
def fake_adapters(monkeypatch: pytest.MonkeyPatch) -> FakeGraphDB:
    """Install fake adapters so MCP tools can run without real services."""
    graph_db = FakeGraphDB()
    graph_db.relational_db = FakeRelationalDB()  # type: ignore[attr-defined]
    graph_db.message_queue = FakeMessageQueue()  # type: ignore[attr-defined]
    monkeypatch.setattr(deps, "_neo4j_adapter", graph_db)
    monkeypatch.setattr(deps, "_postgres_adapter", graph_db.relational_db)
    monkeypatch.setattr(deps, "_redis_adapter", graph_db.message_queue)
    return graph_db


@pytest.mark.asyncio
async def test_mcp_lists_expected_tools(fake_adapters: FakeGraphDB) -> None:
    """The MCP server should register the main analysis and mutation tools."""
    tools = await mcp_server.chain_analysis_mcp.list_tools()
    tool_names = {tool.name for tool in tools}

    assert "get_entity" in tool_names
    assert "get_graph_stats" in tool_names
    assert "ingest_address" in tool_names
    assert "start_address_investigation" in tool_names
    assert "upsert_entity" in tool_names


@pytest.mark.asyncio
async def test_mcp_get_entity_tool_returns_structured_output(
    fake_adapters: FakeGraphDB,
) -> None:
    """`get_entity` should delegate to the existing entity route logic."""
    result = await mcp_server.chain_analysis_mcp.call_tool(
        "get_entity",
        {"address": fake_adapters.node.address},
    )
    payload = _structured_result(result)

    assert payload["address"] == fake_adapters.node.address
    assert payload["entity_type"] == "CEXHotWallet"
    assert payload["risk_level"] == "low"


@pytest.mark.asyncio
async def test_mcp_upsert_entity_tool_writes_graph_node(
    fake_adapters: FakeGraphDB,
) -> None:
    """`upsert_entity` should validate input and pass a node to the graph adapter."""
    new_address = "0x742d35cc6634c0532925a3b844bc9e7595f0beb0"

    result = await mcp_server.chain_analysis_mcp.call_tool(
        "upsert_entity",
        {
            "address": new_address,
            "entity_type": "Mixer",
            "risk_level": "high",
            "name": "Test Mixer",
            "labels": ["sanctioned"],
            "properties": {"source": "mcp-test"},
        },
    )
    payload = _structured_result(result)

    assert payload["address"] == new_address
    assert payload["entity_type"] == "Mixer"
    assert fake_adapters.upserted_nodes[0].address == new_address
    assert fake_adapters.upserted_nodes[0].properties["risk_level"] == "high"


@pytest.mark.asyncio
async def test_mcp_ingest_address_queues_targeted_fetch(
    fake_adapters: FakeGraphDB,
) -> None:
    """`ingest_address` should create an ingestion run and push queue work."""
    result = await mcp_server.chain_analysis_mcp.call_tool(
        "ingest_address",
        {"address": fake_adapters.node.address},
    )
    payload = _structured_result(result)

    assert payload["address"] == fake_adapters.node.address
    assert payload["status"] == "queued"
    assert payload["run_id"]
    redis_items = fake_adapters.message_queue.redis.items  # type: ignore[attr-defined]
    assert redis_items[0][0] == "ingest:targeted_queue"
    assert payload["run_id"] in redis_items[0][1]


def test_fastapi_app_mounts_mcp_route() -> None:
    """The main FastAPI app should expose the Streamable HTTP MCP mount."""
    app = create_app()
    paths = {route.path for route in app.routes}

    assert "/mcp" in paths


def test_mcp_http_requires_bearer_token(fake_adapters: FakeGraphDB) -> None:
    """Mounted MCP HTTP transport should reject unauthenticated requests."""
    async def fake_init_adapters(settings: Any) -> None:
        return None

    async def fake_close_adapters() -> None:
        return None

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(api_main, "init_adapters", fake_init_adapters)
    monkeypatch.setattr(api_main, "close_adapters", fake_close_adapters)
    _reset_mcp_http_app(monkeypatch)

    app = create_app()
    with TestClient(app, base_url="http://localhost:8000") as client:
        response = client.get("/mcp/")

    monkeypatch.undo()

    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}
    assert response.headers["www-authenticate"] == "Bearer"


def test_mcp_http_accepts_existing_auth_token(
    fake_adapters: FakeGraphDB,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mounted MCP HTTP transport should accept the existing bearer auth scheme."""
    async def fake_init_adapters(settings: Any) -> None:
        return None

    async def fake_close_adapters() -> None:
        return None

    monkeypatch.setattr(api_main, "init_adapters", fake_init_adapters)
    monkeypatch.setattr(api_main, "close_adapters", fake_close_adapters)
    _reset_mcp_http_app(monkeypatch)

    app = create_app()

    async def fake_resolve_current_user_from_token(
        token: str,
        db: Any,
        settings: Any,
    ) -> object:
        assert token == "valid-token"
        return object()

    monkeypatch.setattr(mcp_server, "resolve_current_user_from_token", fake_resolve_current_user_from_token)

    with TestClient(app, base_url="http://localhost:8000") as client:
        response = client.get(
            "/mcp/",
            headers={"Authorization": "Bearer valid-token"},
        )

    assert response.status_code == 406
    assert "mcp-session-id" in response.headers
