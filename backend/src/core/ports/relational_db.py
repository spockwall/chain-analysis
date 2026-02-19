"""
Relational Database protocol for PostgreSQL abstraction.
"""

from typing import Any, Protocol, TypeVar, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession

T = TypeVar("T")


@runtime_checkable
class RelationalDatabase(Protocol):
    """
    Protocol for relational database operations.
    Implementations: PostgresAdapter
    """

    async def connect(self) -> None:
        """Establish connection to the database."""
        ...

    async def close(self) -> None:
        """Close the connection pool."""
        ...

    def session(self) -> AsyncSession:
        """
        Get a new async session for database operations.

        Returns:
            AsyncSession for use in async context manager
        """
        ...

    async def execute(
        self, query: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """
        Execute a raw SQL query.

        Args:
            query: SQL query string
            params: Query parameters

        Returns:
            List of result dictionaries
        """
        ...

    async def execute_many(
        self, query: str, params_list: list[dict[str, Any]]
    ) -> int:
        """
        Execute a query multiple times with different parameters.

        Args:
            query: SQL query string
            params_list: List of parameter dictionaries

        Returns:
            Number of rows affected
        """
        ...

    async def health_check(self) -> bool:
        """
        Check if the database connection is healthy.

        Returns:
            True if healthy, False otherwise
        """
        ...
