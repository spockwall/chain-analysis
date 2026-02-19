"""
FastAPI dependency injection for service adapters.
"""

from fastapi import Depends
from typing import Annotated

from core.adapters import *
from core.config import Settings, get_settings
from core.ports import GraphDatabase, MessageQueue, ObjectStorage, RelationalDatabase

# Singleton instances (initialized at startup)
_neo4j_adapter: Neo4jAdapter | None = None
_postgres_adapter: PostgresAdapter | None = None
_redis_adapter: RedisStreamsAdapter | None = None
_minio_adapter: MinioAdapter | None = None


async def init_adapters(settings: Settings) -> None:
    """Initialize all adapter instances at application startup."""
    global _neo4j_adapter, _postgres_adapter, _redis_adapter, _minio_adapter

    # Neo4j
    _neo4j_adapter = Neo4jAdapter(
        uri=settings.neo4j_uri,
        user=settings.neo4j_user,
        password=settings.neo4j_password,
    )
    await _neo4j_adapter.connect()

    # PostgreSQL
    _postgres_adapter = PostgresAdapter(
        database_url=settings.database_url,
    )
    await _postgres_adapter.connect()

    # Redis
    _redis_adapter = RedisStreamsAdapter(
        redis_url=settings.redis_url,
    )
    await _redis_adapter.connect()

    # MinIO
    _minio_adapter = MinioAdapter(
        endpoint=settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        bucket=settings.minio_bucket,
        secure=settings.minio_secure,
    )
    await _minio_adapter.connect()


async def close_adapters() -> None:
    """Close all adapter instances at application shutdown."""
    if _neo4j_adapter:
        await _neo4j_adapter.close()
    if _postgres_adapter:
        await _postgres_adapter.close()
    if _redis_adapter:
        await _redis_adapter.close()
    if _minio_adapter:
        await _minio_adapter.close()


def get_graph_db() -> GraphDatabase:
    """Get the graph database adapter."""
    if _neo4j_adapter is None:
        raise RuntimeError("Neo4j adapter not initialized")
    return _neo4j_adapter


def get_relational_db() -> RelationalDatabase:
    """Get the relational database adapter."""
    if _postgres_adapter is None:
        raise RuntimeError("PostgreSQL adapter not initialized")
    return _postgres_adapter


def get_message_queue() -> MessageQueue:
    """Get the message queue adapter."""
    if _redis_adapter is None:
        raise RuntimeError("Redis adapter not initialized")
    return _redis_adapter


def get_object_storage() -> ObjectStorage:
    """Get the object storage adapter."""
    if _minio_adapter is None:
        raise RuntimeError("MinIO adapter not initialized")
    return _minio_adapter


# Type aliases for dependency injection
SettingsDep = Annotated[Settings, Depends(get_settings)]
GraphDBDep = Annotated[GraphDatabase, Depends(get_graph_db)]
RelationalDBDep = Annotated[RelationalDatabase, Depends(get_relational_db)]
MessageQueueDep = Annotated[MessageQueue, Depends(get_message_queue)]
ObjectStorageDep = Annotated[ObjectStorage, Depends(get_object_storage)]
