"""
Entity service for business logic related to blockchain entities.
"""

from typing import Any

from core.ports import GraphDatabase, RelationalDatabase
from core.ports.graph_db import Node, Subgraph
from libs import logger


class EntityService:
    """Service for entity-related business logic."""

    def __init__(
        self,
        graph_db: GraphDatabase,
        relational_db: RelationalDatabase,
    ) -> None:
        self._graph_db = graph_db
        self._relational_db = relational_db

    async def get_entity_with_known_label(self, address: str) -> dict[str, Any] | None:
        """
        Get entity data enriched with known labels from PostgreSQL.

        Args:
            address: Entity address

        Returns:
            Entity data with known labels merged
        """
        address = address.lower()

        # Get graph node
        node = await self._graph_db.get_node(address)

        # Get known label from PostgreSQL
        known_labels = await self._relational_db.execute(
            """
            SELECT name, entity_type, category, subcategory, risk_level, verified
            FROM known_labels
            WHERE address = :address AND chain_id = 1
            """,
            {"address": address},
        )

        if not node and not known_labels:
            return None

        # Merge data
        result: dict[str, Any] = {
            "address": address,
            "labels": [],
            "properties": {},
        }

        if node:
            result["labels"] = node.labels
            result["properties"] = node.properties

        if known_labels:
            known = known_labels[0]
            result["name"] = known.get("name")
            result["entity_type"] = known.get("entity_type")
            result["category"] = known.get("category")
            result["subcategory"] = known.get("subcategory")
            result["risk_level"] = known.get("risk_level", "unknown")
            result["verified"] = known.get("verified", False)

        return result

    async def get_risk_propagation(
        self,
        address: str,
        max_depth: int = 3,
    ) -> dict[str, Any]:
        """
        Calculate risk propagation from a high-risk entity.

        Uses label propagation to identify entities that have
        received funds from high-risk addresses.

        Args:
            address: Starting address
            max_depth: Maximum hop distance

        Returns:
            Risk propagation results
        """
        # Get entity and its risk level
        entity = await self.get_entity_with_known_label(address)
        if not entity:
            return {"error": "Entity not found"}

        # Get outgoing transfers
        subgraph = await self._graph_db.get_neighbors(
            address=address,
            depth=max_depth,
            direction="out",
            edge_types=["TRANSFER"],
            limit=500,
        )

        # Calculate risk scores based on distance
        risk_scores: dict[str, float] = {}
        source_risk = self._risk_level_to_score(entity.get("risk_level", "unknown"))

        for node in subgraph.nodes:
            if node.address == address:
                continue

            # Find shortest path distance
            paths = await self._graph_db.find_paths(
                source=address,
                target=node.address,
                max_depth=max_depth,
                edge_types=["TRANSFER"],
                limit=1,
            )

            if paths:
                distance = len(paths[0].edges)
                # Risk decays with distance
                propagated_risk = source_risk * (0.5 ** distance)
                risk_scores[node.address] = propagated_risk

        return {
            "source_address": address,
            "source_risk": source_risk,
            "propagated_risks": risk_scores,
            "total_entities": len(risk_scores),
        }

    def _risk_level_to_score(self, risk_level: str) -> float:
        """Convert risk level to numeric score."""
        scores = {
            "unknown": 0.0,
            "low": 0.2,
            "medium": 0.5,
            "high": 0.8,
            "critical": 1.0,
        }
        return scores.get(risk_level, 0.0)

    async def detect_clustering(
        self,
        addresses: list[str],
    ) -> dict[str, Any]:
        """
        Detect if addresses belong to the same cluster/entity.

        Uses common patterns like:
        - Shared funding source
        - Sequential transactions
        - Similar transaction patterns

        Args:
            addresses: List of addresses to analyze

        Returns:
            Clustering analysis results
        """
        if len(addresses) < 2:
            return {"error": "Need at least 2 addresses"}

        # Find common neighbors (potential funding sources)
        common_sources: set[str] = set()

        for i, addr in enumerate(addresses):
            neighbors = await self._graph_db.get_neighbors(
                address=addr,
                depth=1,
                direction="in",
                edge_types=["TRANSFER"],
                limit=100,
            )

            sources = {n.address for n in neighbors.nodes if n.address != addr}

            if i == 0:
                common_sources = sources
            else:
                common_sources &= sources

        # Check for direct connections between addresses
        direct_connections = []
        for i, addr1 in enumerate(addresses):
            for addr2 in addresses[i + 1:]:
                paths = await self._graph_db.find_paths(
                    source=addr1,
                    target=addr2,
                    max_depth=2,
                    limit=1,
                )
                if paths:
                    direct_connections.append({
                        "from": addr1,
                        "to": addr2,
                        "path_length": len(paths[0].edges),
                    })

        # Calculate cluster likelihood
        cluster_score = 0.0
        if common_sources:
            cluster_score += 0.4 * min(len(common_sources) / 3, 1.0)
        if direct_connections:
            cluster_score += 0.6 * min(len(direct_connections) / len(addresses), 1.0)

        return {
            "addresses": addresses,
            "common_funding_sources": list(common_sources)[:10],
            "direct_connections": direct_connections,
            "cluster_likelihood": cluster_score,
            "likely_same_entity": cluster_score > 0.7,
        }
