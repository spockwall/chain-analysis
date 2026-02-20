"""
Dagster resources wrapping the core adapters.

These resources allow Dagster to manage the lifecycle and configuration
of Neo4j, PostgreSQL, and Redis connections.
"""

import os

from dagster import ConfigurableResource

from core.adapters.neo4j_adapter import Neo4jAdapter
from core.adapters.postgres_adapter import PostgresAdapter
from core.adapters.redis_adapter import RedisStreamsAdapter


class Neo4jResource(ConfigurableResource):
    """Dagster resource for Neo4j adapter."""

    uri: str = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user: str = os.getenv("NEO4J_USER", "neo4j")
    password: str = os.getenv("NEO4J_PASSWORD", "password123")
    database: str = os.getenv("NEO4J_DATABASE", "neo4j")

    def create_adapter(self) -> Neo4jAdapter:
        """Create a new Neo4jAdapter instance."""
        return Neo4jAdapter(
            uri=self.uri,
            user=self.user,
            password=self.password,
            database=self.database,
        )


class PostgresResource(ConfigurableResource):
    """Dagster resource for PostgreSQL adapter."""

    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:password123@localhost:5432/chain_analysis",
    )
    pool_size: int = 5
    max_overflow: int = 10

    def create_adapter(self) -> PostgresAdapter:
        """Create a new PostgresAdapter instance."""
        return PostgresAdapter(
            database_url=self.database_url,
            pool_size=self.pool_size,
            max_overflow=self.max_overflow,
        )


class RedisResource(ConfigurableResource):
    """Dagster resource for Redis Streams adapter."""

    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    max_connections: int = 10

    def create_adapter(self) -> RedisStreamsAdapter:
        """Create a new RedisStreamsAdapter instance."""
        return RedisStreamsAdapter(
            redis_url=self.redis_url,
            max_connections=self.max_connections,
        )
