"""
Graph Database protocol for Neo4j/Neptune abstraction.
"""

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass
class Node:
    """Represents a graph node (Entity)."""

    address: str
    labels: list[str] = field(default_factory=list)
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class Edge:
    """Represents a graph edge (TRANSFER, CALLS, etc.)."""

    source: str
    target: str
    edge_type: str
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class Path:
    """Represents a path between two nodes."""

    nodes: list[Node]
    edges: list[Edge]
    total_value: str | None = None  # Wei as string to avoid precision loss


@dataclass
class Subgraph:
    """Represents a subgraph (neighborhood exploration result)."""

    nodes: list[Node]
    edges: list[Edge]
    center_address: str | None = None


@runtime_checkable
class GraphDatabase(Protocol):
    """
    Protocol for graph database operations.
    Implementations: Neo4jAdapter, NeptuneAdapter (future)
    """

    async def connect(self) -> None:
        """Establish connection to the graph database."""
        ...

    async def close(self) -> None:
        """Close the connection."""
        ...

    async def execute_query(
        self, query: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """
        Execute a raw query and return results.

        Args:
            query: Cypher query string (Neo4j) or Gremlin (Neptune)
            params: Query parameters

        Returns:
            List of result dictionaries
        """
        ...

    async def upsert_nodes(self, nodes: list[Node]) -> int:
        """
        Upsert nodes using MERGE semantics.

        Args:
            nodes: List of nodes to upsert

        Returns:
            Number of nodes upserted
        """
        ...

    async def upsert_edges(self, edges: list[Edge]) -> int:
        """
        Upsert edges using MERGE semantics.

        Args:
            edges: List of edges to upsert

        Returns:
            Number of edges upserted
        """
        ...

    async def get_node(self, address: str) -> Node | None:
        """
        Get a single node by address.

        Args:
            address: Entity address

        Returns:
            Node if found, None otherwise
        """
        ...

    async def get_neighbors(
        self,
        address: str,
        depth: int = 1,
        direction: str = "both",
        edge_types: list[str] | None = None,
        limit: int = 100,
    ) -> Subgraph:
        """
        Get the neighborhood of a node.

        Args:
            address: Center node address
            depth: Number of hops
            direction: "in", "out", or "both"
            edge_types: Filter by edge types
            limit: Maximum number of nodes to return

        Returns:
            Subgraph containing the neighborhood
        """
        ...

    async def find_paths(
        self,
        source: str,
        target: str,
        max_depth: int = 10,
        edge_types: list[str] | None = None,
        limit: int = 10,
    ) -> list[Path]:
        """
        Find paths between two nodes.

        Args:
            source: Source node address
            target: Target node address
            max_depth: Maximum path length
            edge_types: Filter by edge types
            limit: Maximum number of paths to return

        Returns:
            List of paths
        """
        ...

    # GDS-specific operations (optional capability)
    def supports_gds(self) -> bool:
        """Check if this database supports Graph Data Science algorithms."""
        ...

    async def run_algorithm(
        self, algorithm: str, params: dict[str, Any]
    ) -> dict[str, Any] | None:
        """
        Run a graph algorithm (e.g., PageRank, Louvain).

        Args:
            algorithm: Algorithm name
            params: Algorithm-specific parameters

        Returns:
            Algorithm results, or None if GDS not supported
        """
        ...
