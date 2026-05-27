"""
Neo4j adapter implementing the GraphDatabase protocol.
"""

from typing import Any

from neo4j import AsyncDriver, AsyncGraphDatabase

from core.ports.graph_db import GraphDatabase, Node, Path, Subgraph, Transaction
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

        # UNWIND streams the batch as individual rows — one MERGE per entity.
        # MERGE on entity_address (unique constraint) is a single B-tree point-lookup:
        #   O(log E) per node, O(N log E) total.
        # SET e += merges new properties without overwriting unmentioned fields.
        # APOC variant assigns type sub-labels (:EOA, :Mixer, etc.) dynamically;
        # falls back to plain MERGE if APOC is not installed.
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

        # Entity MERGEs come first so both endpoint nodes are guaranteed to exist
        # before the Transaction node and its relationships are created.
        # ON CREATE SET fires only for newly created entities — existing ones untouched.
        # from_address / to_address are stored as Transaction properties in addition
        # to the SENT/RECEIVED relationships, enabling fallback lookups without traversal.
        # Complexity: O(N · (log E + log T)) ≈ O(N log T).
        query = """
        UNWIND $txs AS tx
        MERGE (from:Entity {address: tx.from_address})
          ON CREATE SET from.risk_level = 'unknown'
        MERGE (to:Entity {address: tx.to_address})
          ON CREATE SET to.risk_level = 'unknown'
        MERGE (t:Transaction {hash: tx.hash})
        SET t += tx.properties,
            t.from_address = tx.from_address,
            t.to_address   = tx.to_address
        MERGE (from)-[:SENT]->(t)
        MERGE (t)-[:RECEIVED]->(to)
        RETURN count(t) AS count
        """

        result = await self.execute_query(query, {"txs": tx_data})
        return result[0]["count"] if result else 0

    async def get_transaction(self, hash: str) -> Transaction | None:
        """Get a single transaction node by hash."""
        # tx_hash unique constraint → O(log T) point-lookup, effectively O(1) at scale.
        # OPTIONAL MATCH follows at most one SENT and one RECEIVED edge each — O(1).
        # OPTIONAL means the query succeeds even if the relationships don't exist yet
        # (tx stored before its entity nodes were linked); falls back to the stored
        # from_address / to_address properties on the Transaction node.
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
        # entity_address unique constraint → O(log E) point-lookup.
        # OPTIONAL MATCH expands all incoming IN_GROUP edges to count group members.
        # count() aggregates in-place — only the integer is returned, not member nodes,
        # keeping payload small. Non-group entities return member_count = 0.
        # Complexity: O(log E + G) where G = number of group members (typically small).
        query = """
        MATCH (e:Entity {address: $address})
        OPTIONAL MATCH (member:Entity)-[:IN_GROUP]->(e)
        RETURN e, labels(e) AS labels, count(member) AS member_count
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

    async def add_group_member(
        self,
        group_address: str,
        member_address: str,
        note: str | None = None,
    ) -> None:
        """Add an entity as a member of a group via IN_GROUP relationship."""
        from datetime import datetime, timezone
        # MATCH (not MERGE) the group — it must already exist; 404 is handled in the route.
        # MERGE the member entity in case it doesn't exist yet (unprocessed address).
        # MERGE the IN_GROUP relationship is idempotent — safe to call repeatedly.
        # added_at and note on the relationship enable temporal auditing and analyst context.
        # Complexity: O(log E) — two index lookups + one edge check.
        query = """
        MATCH (grp:Entity {address: $group})
        MERGE (member:Entity {address: $member})
        MERGE (member)-[rel:IN_GROUP]->(grp)
        ON CREATE SET rel.added_at = $now
        SET rel.note = $note
        """
        now = datetime.now(timezone.utc).isoformat()
        await self.execute_query(
            query,
            {
                "group": group_address,
                "member": member_address,
                "now": now,
                "note": note,
            },
        )

    async def remove_group_member(self, group_address: str, member_address: str) -> None:
        """Remove the IN_GROUP relationship between a member and its group."""
        # Both endpoints resolved via entity_address unique index: O(log E) each.
        # Neo4j intersects the IN_GROUP edges from both sides to find the specific
        # edge, then deletes only the relationship — the entity nodes are untouched.
        # Complexity: O(log E).
        query = """
        MATCH (member:Entity {address: $member})-[r:IN_GROUP]->(grp:Entity {address: $group})
        DELETE r
        """
        await self.execute_query(query, {"group": group_address, "member": member_address})

    async def get_group_members(self, group_address: str) -> list[Node]:
        """Return all entities that are members of the given group."""
        # Anchors on the group via entity_address index, then expands all incoming
        # IN_GROUP edges. Returns full node data for each member so callers can
        # display member properties without extra round-trips.
        # Complexity: O(log E + G) — unavoidably linear in G since all members are returned.
        query = """
        MATCH (member:Entity)-[rel:IN_GROUP]->(grp:Entity {address: $group})
        RETURN member, labels(member) AS labels,
               rel.note AS membership_note,
               rel.added_at AS membership_added_at
        ORDER BY coalesce(toString(rel.added_at), ""), member.address
        """
        result = await self.execute_query(query, {"group": group_address})
        nodes: list[Node] = []
        for record in result:
            node_data = dict(record["member"])
            node_address = node_data.pop("address")
            node_data["membership_note"] = record.get("membership_note")
            node_data["membership_added_at"] = record.get("membership_added_at")
            nodes.append(Node(
                address=node_address,
                labels=[l for l in record["labels"] if l != "Entity"],
                properties=node_data,
            ))
        return nodes

    async def get_group_parent(self, member_address: str) -> "Node | None":
        """Return the group node this address belongs to, or None."""
        # Index lookup on member address, then follows its single outgoing IN_GROUP edge.
        # Business rules enforce at-most-one-group membership, so this traversal
        # always terminates after exactly one edge — it never fans out.
        # Complexity: O(log E).
        query = """
        MATCH (member:Entity {address: $member})-[:IN_GROUP]->(grp:Entity)
        RETURN grp, labels(grp) AS labels
        """
        result = await self.execute_query(query, {"member": member_address})
        if not result:
            return None
        record = result[0]
        node_data = dict(record["grp"])
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
        limit: int = 100,
    ) -> Subgraph:
        """Get the neighborhood of a node via Transaction nodes."""
        # All three direction variants anchor on the entity_address unique index and
        # traverse SENT/RECEIVED relationships — no Transaction property scan occurs.
        # Complexity: O(log E + K) where K = tx degree, bounded by LIMIT.
        # Order by block_number DESC so when LIMIT truncates we keep the most
        # recent txs — critical for high-volume addresses (exchanges, mixers)
        # where an unordered LIMIT would return arbitrary slices.
        if direction == "out":
            query = """
            MATCH (center:Entity {address: $address})-[:SENT]->(tx:Transaction)-[:RECEIVED]->(neighbor:Entity)
            WITH tx, neighbor
            ORDER BY tx.block_number DESC
            LIMIT $limit
            RETURN
                collect(DISTINCT neighbor) AS neighbors,
                collect(DISTINCT tx)       AS txs
            """
        elif direction == "in":
            query = """
            MATCH (neighbor:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(center:Entity {address: $address})
            WITH tx, neighbor
            ORDER BY tx.block_number DESC
            LIMIT $limit
            RETURN
                collect(DISTINCT neighbor) AS neighbors,
                collect(DISTINCT tx)       AS txs
            """
        else:
            # Union out + in at the row level so LIMIT caps the combined tx set
            # (previous version collected everything first, then LIMIT on a single
            # row did nothing useful — thousands of edges would hit the canvas).
            query = """
            CALL {
                MATCH (:Entity {address: $address})-[:SENT]->(tx:Transaction)-[:RECEIVED]->(neighbor:Entity)
                RETURN tx, neighbor
                UNION
                MATCH (neighbor:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(:Entity {address: $address})
                RETURN tx, neighbor
            }
            WITH tx, neighbor
            ORDER BY tx.block_number DESC
            LIMIT $limit
            RETURN
                collect(DISTINCT neighbor) AS neighbors,
                collect(DISTINCT tx)       AS txs
            """

        result = await self.execute_query(
            query, {"address": address, "limit": limit}
        )

        # Parse Entity nodes
        nodes: list[Node] = []
        seen_addresses: set[str] = set()

        # Parse Transaction nodes
        transactions: list[Transaction] = []
        seen_hashes: set[str] = set()

        if result:
            record = result[0]

            for neighbor in record["neighbors"]:
                if neighbor is None:
                    continue
                neighbor_data = dict(neighbor)
                neighbor_addr = neighbor_data.pop("address", None)
                if neighbor_addr and neighbor_addr not in seen_addresses:
                    nodes.append(Node(address=neighbor_addr, properties=neighbor_data))
                    seen_addresses.add(neighbor_addr)

            for tx_node in record["txs"]:
                if tx_node is None:
                    continue
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
            transactions=transactions,
            center_address=address,
        )

    async def find_paths(
        self,
        source: str,
        target: str,
        max_depth: int = 10,
        limit: int = 10,
    ) -> list[Path]:
        """Find paths between two entities via Transaction nodes.

        Uses quantified path patterns available in Neo4j 5.x.
        Each hop is (Entity)-[:SENT]->(Transaction)-[:RECEIVED]->(Entity).
        """
        # Quantified path pattern: each {1..max_depth} repetition is one entity-to-entity
        # hop via an intermediate Transaction node. The planner runs a bounded BFS/DFS
        # anchored on both source and target via their unique-index lookups.
        # LIMIT provides early termination once enough paths are found.
        # Worst-case complexity: O(K^D) — exponential in depth D, polynomial in degree K.
        # Hub nodes (exchanges, mixers) can have very high K; keep max_depth small (≤6)
        # in production to avoid excessive fan-out.
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

            paths.append(Path(nodes=entity_nodes, transactions=tx_nodes))

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
