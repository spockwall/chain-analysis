"""Tests for the Chain-Analysis MCP server."""

from typing import Any

import pytest

import api.deps as deps
from agent_mcp.server import chain_analysis_mcp
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


def _structured_result(result: Any) -> Any:
    """Extract the structured payload returned by FastMCP `call_tool()`."""
    if isinstance(result, tuple) and len(result) == 2:
        return result[1]
    return result


@pytest.fixture
def fake_adapters(monkeypatch: pytest.MonkeyPatch) -> FakeGraphDB:
    """Install fake adapters so MCP tools can run without real services."""
    graph_db = FakeGraphDB()
    monkeypatch.setattr(deps, "_neo4j_adapter", graph_db)
    monkeypatch.setattr(deps, "_postgres_adapter", object())
    monkeypatch.setattr(deps, "_redis_adapter", object())
    return graph_db


@pytest.mark.asyncio
async def test_mcp_lists_expected_tools(fake_adapters: FakeGraphDB) -> None:
    """The MCP server should register the main analysis and mutation tools."""
    tools = await chain_analysis_mcp.list_tools()
    tool_names = {tool.name for tool in tools}

    assert "get_entity" in tool_names
    assert "get_graph_stats" in tool_names
    assert "upsert_entity" in tool_names


@pytest.mark.asyncio
async def test_mcp_get_entity_tool_returns_structured_output(
    fake_adapters: FakeGraphDB,
) -> None:
    """`get_entity` should delegate to the existing entity route logic."""
    result = await chain_analysis_mcp.call_tool(
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

    result = await chain_analysis_mcp.call_tool(
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


def test_fastapi_app_mounts_mcp_route() -> None:
    """The main FastAPI app should expose the Streamable HTTP MCP mount."""
    app = create_app()
    paths = {route.path for route in app.routes}

    assert "/mcp" in paths
