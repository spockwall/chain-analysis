"""
Neo4j adapter implementing the GraphDatabase protocol.
"""

from typing import Any

from neo4j import AsyncDriver, AsyncGraphDatabase

from core.ports.graph_db import Edge, GraphDatabase, Node, Path, Subgraph
from libs import logger


class Neo4jAdapter:
    """Neo4j implementation of the GraphDatabase protocol."""

    def __init__(
        self,
        uri: str,
        user: str,
        password: str,
        database: str = "neo4j",
    ) -> None:
        self._uri = uri
        self._user = user
        self._password = password
        self._database = database
        self._driver: AsyncDriver | None = None

    async def connect(self) -> None:
        """Establish connection to Neo4j."""
        self._driver = AsyncGraphDatabase.driver(
            self._uri,
            auth=(self._user, self._password),
        )
        # Verify connectivity
        await self._driver.verify_connectivity()
        logger.info("neo4j_connected", uri=self._uri)

    async def close(self) -> None:
        """Close the Neo4j driver."""
        if self._driver:
            await self._driver.close()
            self._driver = None
            logger.info("neo4j_disconnected")

    @property
    def driver(self) -> AsyncDriver:
        if not self._driver:
            raise RuntimeError("Neo4j driver not connected. Call connect() first.")
        return self._driver

    async def execute_query(
        self, query: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """Execute a Cypher query and return results."""
        async with self.driver.session(database=self._database) as session:
            result = await session.run(query, params or {})
            records = await result.data()
            return records

    async def upsert_nodes(self, nodes: list[Node]) -> int:
        """Upsert nodes using MERGE with UNWIND for batching."""
        if not nodes:
            return 0

        # Prepare node data for UNWIND
        node_data = []
        for node in nodes:
            node_data.append({
                "address": node.address,
                "labels": node.labels,
                "properties": node.properties,
            })

        # Use MERGE with UNWIND for idempotent batch upsert
        query = """
        UNWIND $nodes AS node
        MERGE (e:Entity {address: node.address})
        SET e += node.properties
        WITH e, node
        CALL apoc.create.addLabels(e, node.labels) YIELD node AS n
        RETURN count(n) AS count
        """

        # Fallback query without APOC (if APOC not installed)
        fallback_query = """
        UNWIND $nodes AS node
        MERGE (e:Entity {address: node.address})
        SET e += node.properties
        RETURN count(e) AS count
        """

        try:
            result = await self.execute_query(query, {"nodes": node_data})
        except Exception:
            # APOC not available, use fallback
            result = await self.execute_query(fallback_query, {"nodes": node_data})

        return result[0]["count"] if result else 0

    async def upsert_edges(self, edges: list[Edge]) -> int:
        """Upsert edges using MERGE with UNWIND for batching."""
        if not edges:
            return 0

        # Group edges by type for batch processing
        edges_by_type: dict[str, list[dict[str, Any]]] = {}
        for edge in edges:
            if edge.edge_type not in edges_by_type:
                edges_by_type[edge.edge_type] = []
            edges_by_type[edge.edge_type].append({
                "source": edge.source,
                "target": edge.target,
                "properties": edge.properties,
            })

        total_count = 0
        for edge_type, edge_data in edges_by_type.items():
            query = f"""
            UNWIND $edges AS edge
            MATCH (s:Entity {{address: edge.source}})
            MATCH (t:Entity {{address: edge.target}})
            MERGE (s)-[r:{edge_type}]->(t)
            SET r += edge.properties
            RETURN count(r) AS count
            """
            result = await self.execute_query(query, {"edges": edge_data})
            total_count += result[0]["count"] if result else 0

        return total_count

    async def get_node(self, address: str) -> Node | None:
        """Get a single node by address."""
        query = """
        MATCH (e:Entity {address: $address})
        RETURN e, labels(e) AS labels
        """
        result = await self.execute_query(query, {"address": address})
        if not result:
            return None

        record = result[0]
        node_data = dict(record["e"])
        node_address = node_data.pop("address")
        return Node(
            address=node_address,
            labels=[l for l in record["labels"] if l != "Entity"],
            properties=node_data,
        )

    async def get_neighbors(
        self,
        address: str,
        depth: int = 1,
        direction: str = "both",
        edge_types: list[str] | None = None,
        limit: int = 100,
    ) -> Subgraph:
        """Get the neighborhood of a node."""
        # Build direction pattern
        if direction == "in":
            pattern = "<-[r*1..{depth}]-"
        elif direction == "out":
            pattern = "-[r*1..{depth}]->"
        else:
            pattern = "-[r*1..{depth}]-"

        pattern = pattern.format(depth=depth)

        # Build edge type filter
        if edge_types:
            type_filter = ":" + "|".join(edge_types)
            pattern = pattern.replace("[r*", f"[r{type_filter}*")

        query = f"""
        MATCH (center:Entity {{address: $address}})
        MATCH path = (center){pattern}(neighbor:Entity)
        WITH center, neighbor, relationships(path) AS rels
        LIMIT $limit
        RETURN
            collect(DISTINCT neighbor) AS neighbors,
            collect(DISTINCT rels) AS all_rels,
            center
        """

        result = await self.execute_query(
            query, {"address": address, "limit": limit}
        )

        if not result:
            return Subgraph(nodes=[], edges=[], center_address=address)

        record = result[0]

        # Parse nodes
        nodes: list[Node] = []
        seen_addresses: set[str] = set()

        # Add center node
        center_data = dict(record["center"])
        center_addr = center_data.pop("address")
        nodes.append(Node(address=center_addr, properties=center_data))
        seen_addresses.add(center_addr)

        # Add neighbor nodes
        for neighbor in record["neighbors"]:
            neighbor_data = dict(neighbor)
            neighbor_addr = neighbor_data.pop("address")
            if neighbor_addr not in seen_addresses:
                nodes.append(Node(address=neighbor_addr, properties=neighbor_data))
                seen_addresses.add(neighbor_addr)

        # Parse edges
        edges: list[Edge] = []
        seen_edges: set[tuple[str, str, str]] = set()

        for rel_list in record["all_rels"]:
            for rel in rel_list:
                source = rel.start_node["address"]
                target = rel.end_node["address"]
                edge_type = rel.type
                edge_key = (source, target, edge_type)
                if edge_key not in seen_edges:
                    edges.append(Edge(
                        source=source,
                        target=target,
                        edge_type=edge_type,
                        properties=dict(rel),
                    ))
                    seen_edges.add(edge_key)

        return Subgraph(nodes=nodes, edges=edges, center_address=address)

    async def find_paths(
        self,
        source: str,
        target: str,
        max_depth: int = 10,
        edge_types: list[str] | None = None,
        limit: int = 10,
    ) -> list[Path]:
        """Find paths between two nodes."""
        # Build edge type filter
        type_filter = ""
        if edge_types:
            type_filter = ":" + "|".join(edge_types)

        query = f"""
        MATCH path = shortestPath(
            (s:Entity {{address: $source}})-[r{type_filter}*1..{max_depth}]->(t:Entity {{address: $target}})
        )
        RETURN path
        LIMIT $limit
        """

        result = await self.execute_query(
            query, {"source": source, "target": target, "limit": limit}
        )

        paths: list[Path] = []
        for record in result:
            path_data = record["path"]

            # Parse nodes
            nodes = []
            for node in path_data.nodes:
                node_data = dict(node)
                addr = node_data.pop("address")
                nodes.append(Node(address=addr, properties=node_data))

            # Parse edges
            edges = []
            for rel in path_data.relationships:
                edges.append(Edge(
                    source=rel.start_node["address"],
                    target=rel.end_node["address"],
                    edge_type=rel.type,
                    properties=dict(rel),
                ))

            paths.append(Path(nodes=nodes, edges=edges))

        return paths

    def supports_gds(self) -> bool:
        """Neo4j with GDS plugin supports graph algorithms."""
        return True

    async def run_algorithm(
        self, algorithm: str, params: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Run a GDS algorithm."""
        # Map algorithm names to GDS procedures
        algo_map = {
            "pagerank": "gds.pageRank",
            "betweenness": "gds.betweenness",
            "louvain": "gds.louvain",
            "label_propagation": "gds.labelPropagation",
        }

        if algorithm.lower() not in algo_map:
            logger.warning("unknown_algorithm", algorithm=algorithm)
            return None

        proc = algo_map[algorithm.lower()]

        # This is a simplified example - real implementation would need
        # graph projection and proper parameter handling
        query = f"""
        CALL {proc}.stream($params)
        YIELD nodeId, score
        RETURN gds.util.asNode(nodeId).address AS address, score
        ORDER BY score DESC
        LIMIT 100
        """

        try:
            result = await self.execute_query(query, {"params": params})
            return {"algorithm": algorithm, "results": result}
        except Exception as e:
            logger.error("gds_algorithm_failed", algorithm=algorithm, error=str(e))
            return None


# Type assertion to verify protocol compliance
def _check_protocol() -> None:
    adapter: GraphDatabase = Neo4jAdapter("", "", "")
    assert isinstance(adapter, GraphDatabase)
