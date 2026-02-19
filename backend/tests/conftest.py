"""
Pytest fixtures for chain-analysis backend tests.
"""

import asyncio
import sys
from pathlib import Path
from typing import AsyncGenerator, Generator

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

# Add src directory to path for imports
src_path = Path(__file__).parent.parent / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

from api.main import create_app
from core.config import Settings


@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Create event loop for async tests."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def settings() -> Settings:
    """Get test settings."""
    return Settings(
        environment="local",
        neo4j_uri="bolt://localhost:7687",
        neo4j_user="neo4j",
        neo4j_password="password123",
        postgres_host="localhost",
        postgres_port=5432,
        postgres_db="chain_analysis_test",
        postgres_user="postgres",
        postgres_password="postgres123",
        redis_url="redis://localhost:6379",
    )


@pytest.fixture
def app():
    """Create test application."""
    return create_app()


@pytest.fixture
def client(app) -> Generator[TestClient, None, None]:
    """Create test client (sync)."""
    with TestClient(app) as c:
        yield c


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Create async test client."""
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


# Mock data fixtures


@pytest.fixture
def sample_entity() -> dict:
    """Sample entity data."""
    return {
        "address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "entity_type": "CEXHotWallet",
        "risk_level": "low",
        "name": "Binance Hot Wallet",
        "labels": ["exchange", "cex"],
        "first_seen_block": 10000000,
        "last_seen_block": 18000000,
        "transaction_count": 1000000,
    }


@pytest.fixture
def sample_transfer() -> dict:
    """Sample transfer data."""
    return {
        "tx_hash": "0x" + "a" * 64,
        "block_number": 17000000,
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "value": "1000000000000000000",  # 1 ETH in wei
        "timestamp": "2024-01-01T00:00:00Z",
    }


@pytest.fixture
def sample_label_task() -> dict:
    """Sample labeling task data."""
    return {
        "entity_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        "title": "Review suspicious activity",
        "description": "Entity shows mixer-like behavior",
        "priority": 5,
    }
