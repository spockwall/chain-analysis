"""
Tests for service adapters and dependency injection.

These tests verify:
1. Adapter initialization and connection
2. Health checks for each service
3. Dependency injection functions
4. Adapter cleanup on shutdown
"""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add src directory to path for imports
src_path = Path(__file__).parent.parent / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

from core.adapters import *
from core.config import Settings
from api.deps import (
    init_adapters,
    close_adapters,
    get_graph_db,
    get_relational_db,
    get_message_queue,
    get_object_storage,
)


@pytest.fixture
def test_settings() -> Settings:
    """Test settings with default values."""
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
        minio_endpoint="localhost:9000",
        minio_access_key="minioadmin",
        minio_secret_key="minioadmin123",
        minio_bucket="test-bucket",
        minio_secure=False,
    )


class TestNeo4jAdapter:
    """Tests for Neo4j adapter."""

    @pytest.mark.asyncio
    async def test_connect_and_close(self):
        """Test Neo4j connection lifecycle."""
        with patch("core.adapters.neo4j_adapter.AsyncGraphDatabase") as mock_driver:
            mock_driver_instance = AsyncMock()
            mock_driver.driver.return_value = mock_driver_instance
            mock_driver_instance.verify_connectivity = AsyncMock()
            mock_driver_instance.close = AsyncMock()

            adapter = Neo4jAdapter(
                uri="bolt://localhost:7687",
                user="neo4j",
                password="password",
            )

            await adapter.connect()
            assert adapter._driver is not None
            mock_driver_instance.verify_connectivity.assert_called_once()

            await adapter.close()
            mock_driver_instance.close.assert_called_once()
            assert adapter._driver is None

    @pytest.mark.asyncio
    async def test_driver_not_connected_raises_error(self):
        """Test that using driver without connecting raises error."""
        adapter = Neo4jAdapter(
            uri="bolt://localhost:7687",
            user="neo4j",
            password="password",
        )

        with pytest.raises(RuntimeError, match="Neo4j driver not connected"):
            _ = adapter.driver


class TestPostgresAdapter:
    """Tests for PostgreSQL adapter."""

    @pytest.mark.asyncio
    async def test_connect_and_close(self):
        """Test PostgreSQL connection lifecycle."""
        with patch("core.adapters.postgres_adapter.create_async_engine") as mock_engine:
            mock_engine_instance = MagicMock()
            mock_engine_instance.dispose = AsyncMock()
            mock_engine.return_value = mock_engine_instance

            adapter = PostgresAdapter(
                database_url="postgresql+asyncpg://user:pass@localhost/db"
            )

            await adapter.connect()
            assert adapter._engine is not None
            assert adapter._session_factory is not None

            await adapter.close()
            mock_engine_instance.dispose.assert_called_once()
            assert adapter._engine is None

    @pytest.mark.asyncio
    async def test_health_check(self):
        """Test health check."""
        with patch("core.adapters.postgres_adapter.create_async_engine") as mock_engine:
            mock_session = AsyncMock()
            mock_session.execute = AsyncMock()

            mock_session_factory = MagicMock()
            mock_session_factory.return_value.__aenter__ = AsyncMock(
                return_value=mock_session
            )
            mock_session_factory.return_value.__aexit__ = AsyncMock()

            adapter = PostgresAdapter(
                database_url="postgresql+asyncpg://user:pass@localhost/db"
            )
            adapter._engine = MagicMock()
            adapter._session_factory = mock_session_factory

            result = await adapter.health_check()
            assert result is True


class TestRedisAdapter:
    """Tests for Redis Streams adapter."""

    @pytest.mark.asyncio
    async def test_connect_and_close(self):
        """Test Redis connection lifecycle."""
        with patch("core.adapters.redis_adapter.Redis") as mock_redis:
            mock_redis_instance = AsyncMock()
            mock_redis_instance.ping = AsyncMock()
            mock_redis_instance.aclose = AsyncMock()
            mock_redis.from_url.return_value = mock_redis_instance

            adapter = RedisStreamsAdapter(redis_url="redis://localhost:6379")

            await adapter.connect()
            assert adapter._redis is not None
            mock_redis_instance.ping.assert_called_once()

            await adapter.close()
            mock_redis_instance.aclose.assert_called_once()
            assert adapter._redis is None

    @pytest.mark.asyncio
    async def test_health_check(self):
        """Test health check."""
        with patch("core.adapters.redis_adapter.Redis") as mock_redis:
            mock_redis_instance = AsyncMock()
            mock_redis_instance.ping = AsyncMock()
            mock_redis.from_url.return_value = mock_redis_instance

            adapter = RedisStreamsAdapter(redis_url="redis://localhost:6379")
            await adapter.connect()

            result = await adapter.health_check()
            assert result is True

    @pytest.mark.asyncio
    async def test_publish_message(self):
        """Test publishing a message to Redis Stream."""
        with patch("core.adapters.redis_adapter.Redis") as mock_redis:
            mock_redis_instance = AsyncMock()
            mock_redis_instance.ping = AsyncMock()
            mock_redis_instance.xadd = AsyncMock(return_value=b"1234567890-0")
            mock_redis.from_url.return_value = mock_redis_instance

            adapter = RedisStreamsAdapter(redis_url="redis://localhost:6379")
            await adapter.connect()

            msg_id = await adapter.publish("test-stream", b"test message")
            assert msg_id == "1234567890-0"
            mock_redis_instance.xadd.assert_called_once()


class TestMinioAdapter:
    """Tests for MinIO adapter."""

    @pytest.mark.asyncio
    async def test_connect_and_close(self):
        """Test MinIO connection lifecycle."""
        with patch("core.adapters.minio_adapter.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_client.bucket_exists.return_value = True
            mock_minio.return_value = mock_client

            adapter = MinioAdapter(
                endpoint="localhost:9000",
                access_key="minioadmin",
                secret_key="minioadmin123",
                bucket="test-bucket",
                secure=False,
            )

            await adapter.connect()
            assert adapter._client is not None

            await adapter.close()
            assert adapter._client is None

    @pytest.mark.asyncio
    async def test_bucket_creation(self):
        """Test bucket creation if not exists."""
        with patch("core.adapters.minio_adapter.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_client.bucket_exists.return_value = False
            mock_client.make_bucket = MagicMock()
            mock_minio.return_value = mock_client

            adapter = MinioAdapter(
                endpoint="localhost:9000",
                access_key="minioadmin",
                secret_key="minioadmin123",
                bucket="new-bucket",
                secure=False,
            )

            await adapter.connect()
            mock_client.make_bucket.assert_called_once_with("new-bucket")

    @pytest.mark.asyncio
    async def test_health_check(self):
        """Test health check."""
        with patch("core.adapters.minio_adapter.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_client.bucket_exists.return_value = True
            mock_minio.return_value = mock_client

            adapter = MinioAdapter(
                endpoint="localhost:9000",
                access_key="minioadmin",
                secret_key="minioadmin123",
                bucket="test-bucket",
                secure=False,
            )
            await adapter.connect()

            result = await adapter.health_check()
            assert result is True


class TestDependencyInjection:
    """Tests for dependency injection functions."""

    def test_get_graph_db_not_initialized(self):
        """Test get_graph_db raises error when not initialized."""
        import api.deps as deps

        deps._neo4j_adapter = None

        with pytest.raises(RuntimeError, match="Neo4j adapter not initialized"):
            get_graph_db()

    def test_get_relational_db_not_initialized(self):
        """Test get_relational_db raises error when not initialized."""
        import api.deps as deps

        deps._postgres_adapter = None

        with pytest.raises(RuntimeError, match="PostgreSQL adapter not initialized"):
            get_relational_db()

    def test_get_message_queue_not_initialized(self):
        """Test get_message_queue raises error when not initialized."""
        import api.deps as deps

        deps._redis_adapter = None

        with pytest.raises(RuntimeError, match="Redis adapter not initialized"):
            get_message_queue()

    def test_get_object_storage_not_initialized(self):
        """Test get_object_storage raises error when not initialized."""
        import api.deps as deps

        deps._minio_adapter = None

        with pytest.raises(RuntimeError, match="MinIO adapter not initialized"):
            get_object_storage()

    @pytest.mark.asyncio
    async def test_init_and_close_adapters(self, test_settings):
        """Test adapter initialization and cleanup."""
        import api.deps as deps

        with (
            patch.object(
                Neo4jAdapter, "connect", new_callable=AsyncMock
            ) as mock_neo4j_connect,
            patch.object(
                Neo4jAdapter, "close", new_callable=AsyncMock
            ) as mock_neo4j_close,
            patch.object(
                PostgresAdapter, "connect", new_callable=AsyncMock
            ) as mock_pg_connect,
            patch.object(
                PostgresAdapter, "close", new_callable=AsyncMock
            ) as mock_pg_close,
            patch.object(
                RedisStreamsAdapter, "connect", new_callable=AsyncMock
            ) as mock_redis_connect,
            patch.object(
                RedisStreamsAdapter, "close", new_callable=AsyncMock
            ) as mock_redis_close,
            patch.object(
                MinioAdapter, "connect", new_callable=AsyncMock
            ) as mock_minio_connect,
            patch.object(
                MinioAdapter, "close", new_callable=AsyncMock
            ) as mock_minio_close,
        ):
            # Initialize adapters
            await init_adapters(test_settings)

            # Verify all connect methods were called
            mock_neo4j_connect.assert_called_once()
            mock_pg_connect.assert_called_once()
            mock_redis_connect.assert_called_once()
            mock_minio_connect.assert_called_once()

            # Verify adapters are set
            assert deps._neo4j_adapter is not None
            assert deps._postgres_adapter is not None
            assert deps._redis_adapter is not None
            assert deps._minio_adapter is not None

            # Close adapters
            await close_adapters()

            # Verify all close methods were called
            mock_neo4j_close.assert_called_once()
            mock_pg_close.assert_called_once()
            mock_redis_close.assert_called_once()
            mock_minio_close.assert_called_once()


class TestAdapterIntegration:
    """Integration tests that require running services.

    These tests are marked with `integration` and skipped by default.
    Run with: pytest -m integration
    """

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_neo4j_real_connection(self):
        """Test real Neo4j connection."""
        adapter = Neo4jAdapter(
            uri="bolt://localhost:7687",
            user="neo4j",
            password="password123",
        )
        try:
            await adapter.connect()
            result = await adapter.execute_query("RETURN 1 AS ok")
            assert result == [{"ok": 1}]
        finally:
            await adapter.close()

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_postgres_real_connection(self):
        """Test real PostgreSQL connection."""
        adapter = PostgresAdapter(
            database_url="postgresql+asyncpg://postgres:postgres123@localhost:5432/chain_analysis"
        )
        try:
            await adapter.connect()
            result = await adapter.health_check()
            assert result is True
        finally:
            await adapter.close()

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_redis_real_connection(self):
        """Test real Redis connection."""
        adapter = RedisStreamsAdapter(redis_url="redis://localhost:6379")
        try:
            await adapter.connect()
            result = await adapter.health_check()
            assert result is True
        finally:
            await adapter.close()

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_minio_real_connection(self):
        """Test real MinIO connection."""
        adapter = MinioAdapter(
            endpoint="localhost:9000",
            access_key="minioadmin",
            secret_key="minioadmin123",
            bucket="chain-analysis",
            secure=False,
        )
        try:
            await adapter.connect()
            result = await adapter.health_check()
            assert result is True
        finally:
            await adapter.close()
