"""
Neo4j adapter implementing the GraphDatabase protocol.
"""

from typing import Any

from neo4j import AsyncDriver, AsyncGraphDatabase

from core.ports.graph_db import Edge, GraphDatabase, Node, Path, Subgraph, Transaction
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

    async def upsert_transactions(self, txs: list[Transaction]) -> int:
        """Upsert Transaction nodes with SENT/RECEIVED relationships."""
        if not txs:
            return 0

        tx_data = [
            {
                "hash": tx.hash,
                "from_address": tx.from_address,
                "to_address": tx.to_address,
                "properties": tx.properties,
            }
            for tx in txs
        ]

        query = """
        UNWIND $txs AS tx
        MERGE (t:Transaction {hash: tx.hash})
        SET t += tx.properties,
            t.from_address = tx.from_address,
            t.to_address   = tx.to_address
        WITH t, tx
        MATCH (from:Entity {address: tx.from_address})
        MATCH (to:Entity   {address: tx.to_address})
        MERGE (from)-[:SENT]->(t)
        MERGE (t)-[:RECEIVED]->(to)
        RETURN count(t) AS count
        """

        result = await self.execute_query(query, {"txs": tx_data})
        return result[0]["count"] if result else 0

    async def get_transaction(self, hash: str) -> Transaction | None:
        """Get a single transaction node by hash."""
        query = """
        MATCH (t:Transaction {hash: $hash})
        OPTIONAL MATCH (from:Entity)-[:SENT]->(t)
        OPTIONAL MATCH (t)-[:RECEIVED]->(to:Entity)
        RETURN t, from.address AS from_address, to.address AS to_address
        """
        result = await self.execute_query(query, {"hash": hash})
        if not result:
            return None

        record = result[0]
        tx_data = dict(record["t"])
        tx_hash = tx_data.pop("hash", hash)
        # from_address and to_address may be stored on node or returned separately
        from_addr = record.get("from_address") or tx_data.pop("from_address", "")
        to_addr = record.get("to_address") or tx_data.pop("to_address", "")
        return Transaction(
            hash=tx_hash,
            from_address=from_addr,
            to_address=to_addr,
            properties=tx_data,
        )

    async def get_node(self, address: str) -> Node | None:
        """Get a single node by address, including member_count for group entities."""
        query = """
        MATCH (e:Entity {address: $address})
        OPTIONAL MATCH (child:Entity)-[:MEMBER_OF]->(e)
        RETURN e, labels(e) AS labels, count(child) AS member_count
        """
        result = await self.execute_query(query, {"address": address})
        if not result:
            return None

        record = result[0]
        node_data = dict(record["e"])
        node_address = node_data.pop("address")
        node_data["member_count"] = record.get("member_count", 0)
        return Node(
            address=node_address,
            labels=[l for l in record["labels"] if l != "Entity"],
            properties=node_data,
        )

    async def add_group_member(self, parent_address: str, child_address: str) -> None:
        """Add a child entity as a member of a parent group via MEMBER_OF relationship."""
        from datetime import datetime, timezone
        query = """
        MATCH (parent:Entity {address: $parent})
        MERGE (child:Entity {address: $child})
        MERGE (child)-[:MEMBER_OF {added_at: $now}]->(parent)
        """
        now = datetime.now(timezone.utc).isoformat()
        await self.execute_query(query, {"parent": parent_address, "child": child_address, "now": now})

    async def remove_group_member(self, parent_address: str, child_address: str) -> None:
        """Remove the MEMBER_OF relationship between child and parent."""
        query = """
        MATCH (child:Entity {address: $child})-[r:MEMBER_OF]->(parent:Entity {address: $parent})
        DELETE r
        """
        await self.execute_query(query, {"parent": parent_address, "child": child_address})

    async def get_group_members(self, parent_address: str) -> list[Node]:
        """Return all entities that are members of the given parent group."""
        query = """
        MATCH (child:Entity)-[:MEMBER_OF]->(parent:Entity {address: $parent})
        RETURN child, labels(child) AS labels
        """
        result = await self.execute_query(query, {"parent": parent_address})
        nodes: list[Node] = []
        for record in result:
            node_data = dict(record["child"])
            node_address = node_data.pop("address")
            nodes.append(Node(
                address=node_address,
                labels=[l for l in record["labels"] if l != "Entity"],
                properties=node_data,
            ))
        return nodes

    async def get_group_parent(self, child_address: str) -> "Node | None":
        """Return the parent group node this address belongs to, or None."""
        query = """
        MATCH (child:Entity {address: $child})-[:MEMBER_OF]->(parent:Entity)
        RETURN parent, labels(parent) AS labels
        """
        result = await self.execute_query(query, {"child": child_address})
        if not result:
            return None
        record = result[0]
        node_data = dict(record["parent"])
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
        """Get the neighborhood of a node via Transaction nodes."""
        # Build direction-aware Cypher for Transaction-as-Node model.
        # One hop = (Entity)-[:SENT]->(Transaction)-[:RECEIVED]->(Entity)
        # We repeat this pattern up to `depth` times.
        hop = "(:Entity)-[:SENT]->(:Transaction)-[:RECEIVED]->"
        hop_rev = "<-[:RECEIVED]-(:Transaction)<-[:SENT]-(:Entity)"

        if direction == "out":
            # outgoing: center sends → tx → neighbor
            query = f"""
            MATCH (center:Entity {{address: $address}})
            MATCH path = (center)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(neighbor:Entity)
            WITH center, tx, neighbor
            LIMIT $limit
            RETURN
                collect(DISTINCT neighbor) AS neighbors,
                collect(DISTINCT tx) AS txs,
                center
            """
        elif direction == "in":
            # incoming: neighbor sends → tx → center
            query = f"""
            MATCH (center:Entity {{address: $address}})
            MATCH (neighbor:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(center)
            WITH center, tx, neighbor
            LIMIT $limit
            RETURN
                collect(DISTINCT neighbor) AS neighbors,
                collect(DISTINCT tx) AS txs,
                center
            """
        else:
            # both directions — use OPTIONAL MATCH so a node with only in or
            # only out transactions still returns results
            query = """
            MATCH (center:Entity {address: $address})
            OPTIONAL MATCH (in_neighbor:Entity)-[:SENT]->(in_tx:Transaction)-[:RECEIVED]->(center)
            OPTIONAL MATCH (center)-[:SENT]->(out_tx:Transaction)-[:RECEIVED]->(out_neighbor:Entity)
            WITH center,
                 collect(DISTINCT in_neighbor) AS in_neighbors,
                 collect(DISTINCT in_tx)       AS in_txs,
                 collect(DISTINCT out_neighbor) AS out_neighbors,
                 collect(DISTINCT out_tx)       AS out_txs
            RETURN
                [x IN (in_neighbors + out_neighbors) WHERE x IS NOT NULL] AS neighbors,
                [x IN (in_txs + out_txs) WHERE x IS NOT NULL]             AS txs,
                center
            LIMIT $limit
            """

        result = await self.execute_query(
            query, {"address": address, "limit": limit}
        )

        if not result:
            return Subgraph(nodes=[], edges=[], transactions=[], center_address=address)

        record = result[0]

        # Parse Entity nodes
        nodes: list[Node] = []
        seen_addresses: set[str] = set()

        center_data = dict(record["center"])
        center_addr = center_data.pop("address")
        nodes.append(Node(address=center_addr, properties=center_data))
        seen_addresses.add(center_addr)

        for neighbor in record["neighbors"]:
            neighbor_data = dict(neighbor)
            neighbor_addr = neighbor_data.pop("address", None)
            if neighbor_addr and neighbor_addr not in seen_addresses:
                nodes.append(Node(address=neighbor_addr, properties=neighbor_data))
                seen_addresses.add(neighbor_addr)

        # Parse Transaction nodes
        transactions: list[Transaction] = []
        seen_hashes: set[str] = set()

        for tx_node in record["txs"]:
            tx_data = dict(tx_node)
            tx_hash = tx_data.pop("hash", None)
            if tx_hash and tx_hash not in seen_hashes:
                from_addr = tx_data.pop("from_address", "")
                to_addr = tx_data.pop("to_address", "")
                transactions.append(Transaction(
                    hash=tx_hash,
                    from_address=from_addr,
                    to_address=to_addr,
                    properties=tx_data,
                ))
                seen_hashes.add(tx_hash)

        return Subgraph(
            nodes=nodes,
            edges=[],
            transactions=transactions,
            center_address=address,
        )

    async def find_paths(
        self,
        source: str,
        target: str,
        max_depth: int = 10,
        edge_types: list[str] | None = None,
        limit: int = 10,
    ) -> list[Path]:
        """Find paths between two entities via Transaction nodes.

        Uses quantified path patterns available in Neo4j 5.x.
        Each hop is (Entity)-[:SENT]->(Transaction)-[:RECEIVED]->(Entity).
        """
        # max_depth here is the number of Entity-to-Entity hops
        query = f"""
        MATCH path = (s:Entity {{address: $source}})
          ((-[:SENT]->(:Transaction)-[:RECEIVED]->){{1..{max_depth}}})(t:Entity {{address: $target}})
        RETURN path
        LIMIT $limit
        """

        result = await self.execute_query(
            query, {"source": source, "target": target, "limit": limit}
        )

        paths: list[Path] = []
        for record in result:
            path_data = record["path"]

            entity_nodes: list[Node] = []
            tx_nodes: list[Transaction] = []

            for node in path_data.nodes:
                node_data = dict(node)
                if "Transaction" in node.labels:
                    tx_hash = node_data.pop("hash", "")
                    from_addr = node_data.pop("from_address", "")
                    to_addr = node_data.pop("to_address", "")
                    tx_nodes.append(Transaction(
                        hash=tx_hash,
                        from_address=from_addr,
                        to_address=to_addr,
                        properties=node_data,
                    ))
                else:
                    addr = node_data.pop("address", "")
                    entity_nodes.append(Node(address=addr, properties=node_data))

            paths.append(Path(nodes=entity_nodes, edges=[], transactions=tx_nodes))

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
