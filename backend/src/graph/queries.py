"""
Cypher query builders for common graph operations.

All AML queries use the Transaction-as-Node schema:
  (from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)
"""

from dataclasses import dataclass
from typing import Any


@dataclass
class QueryResult:
    """Result of a query builder."""

    query: str
    params: dict[str, Any]


class QueryBuilder:
    """Builder for Neo4j Cypher queries."""

    @staticmethod
    def upsert_entities(batch_size: int = 1000) -> str:
        """
        Generate query for batch upserting entities.

        Use with UNWIND for efficient batch processing:
        UNWIND $nodes AS node
        """
        return """
        UNWIND $nodes AS node
        MERGE (e:Entity {address: node.address})
        SET e += node.properties,
            e.updated_at = datetime()
        WITH e, node
        FOREACH (label IN node.labels |
            SET e:$(label)
        )
        RETURN count(e) AS count
        """

    @staticmethod
    def upsert_transactions() -> str:
        """
        Generate query for batch upserting Transaction nodes.

        Expects $txs array with hash, from_address, to_address, properties.
        Creates SENT/RECEIVED relationships to existing Entity nodes.
        """
        return """
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

    @staticmethod
    def get_entity_stats(address: str) -> QueryResult:
        """Get entity statistics using Transaction-as-Node schema."""
        query = """
        MATCH (e:Entity {address: $address})
        OPTIONAL MATCH (e)-[:SENT]->(out_tx:Transaction)
        OPTIONAL MATCH (in_tx:Transaction)-[:RECEIVED]->(e)
        WITH e,
             count(DISTINCT out_tx) AS outgoing_count,
             count(DISTINCT in_tx)  AS incoming_count,
             sum(toFloat(out_tx.value)) AS total_out,
             sum(toFloat(in_tx.value))  AS total_in
        RETURN e.address AS address,
               labels(e) AS labels,
               outgoing_count,
               incoming_count,
               total_out,
               total_in,
               outgoing_count + incoming_count AS total_transfers
        """
        return QueryResult(query=query, params={"address": address})


class AMLPatternQueries:
    """
    Cypher queries for detecting AML (Anti-Money Laundering) patterns.

    All queries use the Transaction-as-Node schema:
      (from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)

    Common patterns:
    - Peel chain: Sequential small transfers to peel off funds
    - Structuring: Breaking large amounts into smaller ones
    - Round-trip: Funds returning to origin through intermediaries
    - Fan-out/Fan-in: Spreading funds then collecting
    - Timing correlation: Coordinated transactions
    """

    @staticmethod
    def detect_peel_chain(
        start_address: str,
        min_chain_length: int = 5,
        max_time_between_txs: int = 3600,  # 1 hour in seconds
    ) -> QueryResult:
        """
        Detect peel chain pattern.

        A peel chain is a series of transactions where a large amount
        is gradually "peeled off" through sequential transfers.
        Uses quantified path patterns (Neo4j 5.x).
        """
        query = """
        MATCH path = (start:Entity {address: $start_address})
          ((-[:SENT]->(:Transaction)-[:RECEIVED]->){$min_length..10})(:Entity)
        WHERE ALL(tx IN [x IN nodes(path) WHERE x:Transaction] |
            tx.timestamp IS NOT NULL
            AND toFloat(tx.value) > 0)
        WITH path,
             [x IN nodes(path) WHERE x:Transaction] AS txs,
             [x IN nodes(path) WHERE x:Entity]      AS entities
        WHERE size(txs) >= $min_length
        RETURN [n IN entities | n.address] AS chain_addresses,
               [t IN txs | {
                   hash:      t.hash,
                   value:     t.value,
                   timestamp: t.timestamp,
                   block:     t.block_number
               }] AS transactions,
               size(txs) AS chain_length
        ORDER BY chain_length DESC
        LIMIT 20
        """
        return QueryResult(
            query=query.replace("$min_length", str(min_chain_length)),
            params={
                "start_address": start_address,
                "max_time": max_time_between_txs,
            },
        )

    @staticmethod
    def detect_structuring(
        address: str,
        block_window: int = 100,
        min_receivers: int = 3,
    ) -> QueryResult:
        """
        Detect structuring (fan-out) pattern.

        Identifies a source that sends to many receivers within a short
        block window — a common smurfing/structuring indicator.
        """
        query = """
        MATCH (src:Entity {address: $address})-[:SENT]->(tx:Transaction)-[:RECEIVED]->(dst:Entity)
        WITH src, collect(DISTINCT dst) AS receivers, collect(tx.block_number) AS blocks
        WHERE size(receivers) >= $min_receivers
          AND (max(blocks) - min(blocks)) < $block_window
        RETURN src.address        AS source,
               size(receivers)    AS fan_out,
               min(blocks)        AS first_block,
               max(blocks)        AS last_block
        ORDER BY fan_out DESC
        """
        return QueryResult(
            query=query,
            params={
                "address": address,
                "min_receivers": min_receivers,
                "block_window": block_window,
            },
        )

    @staticmethod
    def detect_round_trip(
        address: str,
        max_hops: int = 5,
        limit: int = 10,
    ) -> QueryResult:
        """
        Detect round-trip pattern.

        Round-trip occurs when funds return to the original address
        through a series of intermediaries.
        Uses quantified path patterns (Neo4j 5.x).
        """
        query = """
        MATCH path = (start:Entity {address: $address})
          ((-[:SENT]->(:Transaction)-[:RECEIVED]->){2..$max_hops})(start)
        RETURN path
        LIMIT $limit
        """
        return QueryResult(
            query=query.replace("$max_hops", str(max_hops)),
            params={
                "address": address,
                "limit": limit,
            },
        )

    @staticmethod
    def detect_fan_out_fan_in(
        source_address: str,
        min_receivers: int = 5,
    ) -> QueryResult:
        """
        Detect fan-out/fan-in pattern.

        Funds are spread to multiple intermediaries (fan-out) then
        collected to one or more final destinations (fan-in).
        """
        query = """
        MATCH (src:Entity {address: $address})-[:SENT]->(t1:Transaction)-[:RECEIVED]->(mid:Entity)
        MATCH (mid)-[:SENT]->(t2:Transaction)-[:RECEIVED]->(dst:Entity)
        WHERE src <> dst AND src <> mid AND mid <> dst
        WITH src, collect(DISTINCT dst) AS dsts, count(DISTINCT mid) AS intermediaries
        WHERE size(dsts) >= $min_receivers
        RETURN src.address        AS source,
               intermediaries     AS intermediary_count,
               size(dsts)         AS final_receivers
        """
        return QueryResult(
            query=query,
            params={
                "address": source_address,
                "min_receivers": min_receivers,
            },
        )

    @staticmethod
    def detect_mixer_interaction(
        address: str,
        known_mixer_addresses: list[str] | None = None,
    ) -> QueryResult:
        """
        Detect interactions with known mixers.

        Identifies direct transactions to/from Mixer-labeled nodes.
        """
        # Default known mixers (Tornado Cash)
        default_mixers = [
            "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",  # 0.1 ETH
            "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",  # 10 ETH
            "0xa160cdab225685da1d56aa342ad8841c3b53f291",  # 100 ETH
            "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",  # 1 ETH
        ]

        mixers = known_mixer_addresses or default_mixers

        query = """
        MATCH (e:Entity {address: $address})-[:SENT]->(tx:Transaction)-[:RECEIVED]->(mixer:Mixer)
        RETURN e, tx, mixer, 'deposit' AS direction
        UNION
        MATCH (mixer:Mixer)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(e:Entity {address: $address})
        RETURN e, tx, mixer, 'withdrawal' AS direction
        """
        return QueryResult(
            query=query,
            params={
                "address": address,
                "mixers": mixers,
            },
        )

    @staticmethod
    def find_high_risk_paths(
        source_address: str,
        max_depth: int = 4,
    ) -> QueryResult:
        """
        Find paths to high-risk entities.

        Identifies shortest paths from a source to entities
        marked as high or critical risk using Transaction-as-Node traversal.
        """
        query = """
        MATCH (source:Entity {address: $address})
        MATCH (risky:Entity)
        WHERE risky.risk_level IN ['high', 'critical']
          AND risky.address <> source.address
        MATCH path = (source)
          ((-[:SENT]->(:Transaction)-[:RECEIVED]->){1..$max_depth})(risky)
        WITH path, risky,
             [x IN nodes(path) WHERE x:Transaction] AS txs
        RETURN risky.address  AS high_risk_entity,
               risky.risk_level AS risk_level,
               risky.name    AS entity_name,
               labels(risky) AS entity_labels,
               size(txs)     AS hops,
               [t IN txs | {
                   hash:  t.hash,
                   value: t.value,
                   from:  t.from_address,
                   to:    t.to_address
               }] AS path_transactions
        ORDER BY hops ASC
        LIMIT 20
        """
        return QueryResult(
            query=query.replace("$max_depth", str(max_depth)),
            params={"address": source_address},
        )
