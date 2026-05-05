"""
FastAPI dependency injection for service adapters.
"""

from fastapi import Depends
from typing import Annotated

from core.adapters import *
from core.config import Settings, get_settings
from core.ports import GraphDatabase, MessageQueue, RelationalDatabase

# Singleton instances (initialized at startup)
_neo4j_adapter: Neo4jAdapter | None = None
_postgres_adapter: PostgresAdapter | None = None
_redis_adapter: RedisStreamsAdapter | None = None


async def init_adapters(settings: Settings) -> None:
    """Initialize all adapter instances at application startup."""
    global _neo4j_adapter, _postgres_adapter, _redis_adapter

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


async def close_adapters() -> None:
    """Close all adapter instances at application shutdown."""
    global _neo4j_adapter, _postgres_adapter, _redis_adapter

    if _neo4j_adapter:
        await _neo4j_adapter.close()
    if _postgres_adapter:
        await _postgres_adapter.close()
    if _redis_adapter:
        await _redis_adapter.close()

    _neo4j_adapter = None
    _postgres_adapter = None
    _redis_adapter = None


def adapters_are_initialized() -> bool:
    """Whether all runtime adapters have been initialized."""
    return (
        _neo4j_adapter is not None
        and _postgres_adapter is not None
        and _redis_adapter is not None
    )


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


# Type aliases for dependency injection
SettingsDep = Annotated[Settings, Depends(get_settings)]
GraphDBDep = Annotated[GraphDatabase, Depends(get_graph_db)]
RelationalDBDep = Annotated[RelationalDatabase, Depends(get_relational_db)]
MessageQueueDep = Annotated[MessageQueue, Depends(get_message_queue)]
