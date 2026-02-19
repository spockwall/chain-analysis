"""
PostgreSQL adapter implementing the RelationalDatabase protocol.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from core.ports.relational_db import RelationalDatabase
from libs import logger


class PostgresAdapter:
    """PostgreSQL implementation of the RelationalDatabase protocol."""

    def __init__(
        self,
        database_url: str,
        pool_size: int = 5,
        max_overflow: int = 10,
        echo: bool = False,
    ) -> None:
        self._database_url = database_url
        self._pool_size = pool_size
        self._max_overflow = max_overflow
        self._echo = echo
        self._engine: AsyncEngine | None = None
        self._session_factory: async_sessionmaker[AsyncSession] | None = None

    async def connect(self) -> None:
        """Create the async engine and session factory."""
        self._engine = create_async_engine(
            self._database_url,
            pool_size=self._pool_size,
            max_overflow=self._max_overflow,
            echo=self._echo,
        )
        self._session_factory = async_sessionmaker(
            self._engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        logger.info("postgres_connected", url=self._database_url.split("@")[-1])

    async def close(self) -> None:
        """Dispose of the engine and close all connections."""
        if self._engine:
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None
            logger.info("postgres_disconnected")

    @property
    def engine(self) -> AsyncEngine:
        if not self._engine:
            raise RuntimeError("PostgreSQL not connected. Call connect() first.")
        return self._engine

    def session(self) -> AsyncSession:
        """Get a new session. Use as async context manager."""
        if not self._session_factory:
            raise RuntimeError("PostgreSQL not connected. Call connect() first.")
        return self._session_factory()

    @asynccontextmanager
    async def transaction(self) -> AsyncGenerator[AsyncSession, None]:
        """Get a session with automatic commit/rollback."""
        async with self.session() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def execute(
        self, query: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """Execute a raw SQL query and return results."""
        async with self.session() as session:
            result = await session.execute(text(query), params or {})
            # For SELECT queries, return rows as dicts
            if result.returns_rows:
                rows = result.fetchall()
                columns = result.keys()
                return [dict(zip(columns, row)) for row in rows]
            # For INSERT/UPDATE/DELETE, commit and return empty
            await session.commit()
            return []

    async def execute_many(self, query: str, params_list: list[dict[str, Any]]) -> int:
        """Execute a query multiple times with different parameters."""
        if not params_list:
            return 0

        async with self.transaction() as session:
            total_affected = 0
            for params in params_list:
                result = await session.execute(text(query), params)
                total_affected += result.rowcount or 0
            return total_affected

    async def health_check(self) -> bool:
        """Check if the database connection is healthy."""
        try:
            async with self.session() as session:
                await session.execute(text("SELECT 1"))
                return True
        except Exception as e:
            logger.error("postgres_health_check_failed", error=str(e))
            return False


# Type assertion to verify protocol compliance
def _check_protocol() -> None:
    adapter: RelationalDatabase = PostgresAdapter("")
    assert isinstance(adapter, RelationalDatabase)
