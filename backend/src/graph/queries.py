"""
Cypher query builders for common graph operations.
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
    def upsert_transfers() -> str:
        """
        Generate query for batch upserting transfer edges.

        Expects $edges array with source, target, properties.
        """
        return """
        UNWIND $edges AS edge
        MATCH (s:Entity {address: edge.source})
        MATCH (t:Entity {address: edge.target})
        MERGE (s)-[r:TRANSFER {tx_hash: edge.tx_hash}]->(t)
        SET r += edge.properties
        RETURN count(r) AS count
        """

    @staticmethod
    def get_entity_stats(address: str) -> QueryResult:
        """Get entity statistics."""
        query = """
        MATCH (e:Entity {address: $address})
        OPTIONAL MATCH (e)-[out:TRANSFER]->()
        OPTIONAL MATCH ()-[in:TRANSFER]->(e)
        WITH e,
             count(DISTINCT out) AS outgoing_count,
             count(DISTINCT in) AS incoming_count,
             sum(toFloat(out.value)) AS total_out,
             sum(toFloat(in.value)) AS total_in
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
        """
        query = """
        MATCH path = (start:Entity {address: $start_address})
                     -[:TRANSFER*$min_length..10]->(end:Entity)
        WHERE ALL(r IN relationships(path) WHERE
            r.timestamp IS NOT NULL
        )
        WITH path,
             relationships(path) AS rels,
             nodes(path) AS nodes
        WHERE size(rels) >= $min_length
        // Check sequential timing
        AND ALL(i IN range(0, size(rels)-2) WHERE
            rels[i+1].timestamp - rels[i].timestamp < $max_time
            AND rels[i+1].timestamp > rels[i].timestamp
        )
        // Check decreasing amounts (peel pattern)
        AND ALL(i IN range(0, size(rels)-2) WHERE
            toFloat(rels[i].value) > toFloat(rels[i+1].value)
        )
        RETURN [n IN nodes | n.address] AS chain_addresses,
               [r IN rels | {
                   value: r.value,
                   timestamp: r.timestamp,
                   tx_hash: r.tx_hash
               }] AS transfers,
               size(rels) AS chain_length
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
        time_window_hours: int = 24,
        min_transactions: int = 5,
        max_individual_amount: str = "10000000000000000000",  # 10 ETH in wei
    ) -> QueryResult:
        """
        Detect structuring pattern.

        Structuring is breaking large amounts into smaller transactions
        to avoid detection thresholds.
        """
        query = """
        MATCH (e:Entity {address: $address})-[r:TRANSFER]->(recipient:Entity)
        WHERE r.timestamp > datetime() - duration({hours: $time_window})
        AND toFloat(r.value) < toFloat($max_amount)
        WITH recipient,
             collect(r) AS transfers,
             sum(toFloat(r.value)) AS total_value,
             count(r) AS tx_count
        WHERE tx_count >= $min_txs
        // Check if transfers are roughly similar amounts
        WITH recipient, transfers, total_value, tx_count,
             total_value / tx_count AS avg_value
        WHERE ALL(r IN transfers WHERE
            abs(toFloat(r.value) - avg_value) < avg_value * 0.3
        )
        RETURN recipient.address AS recipient,
               tx_count AS transaction_count,
               total_value AS total_transferred,
               avg_value AS average_amount,
               [r IN transfers | {
                   value: r.value,
                   timestamp: r.timestamp,
                   tx_hash: r.tx_hash
               }] AS transactions
        ORDER BY total_value DESC
        """
        return QueryResult(
            query=query,
            params={
                "address": address,
                "time_window": time_window_hours,
                "min_txs": min_transactions,
                "max_amount": max_individual_amount,
            },
        )

    @staticmethod
    def detect_round_trip(
        address: str,
        max_hops: int = 5,
        time_window_hours: int = 168,  # 1 week
    ) -> QueryResult:
        """
        Detect round-trip pattern.

        Round-trip occurs when funds return to the original address
        through a series of intermediaries.
        """
        query = """
        MATCH path = (start:Entity {address: $address})
                     -[:TRANSFER*2..$max_hops]->(start)
        WHERE ALL(r IN relationships(path) WHERE
            r.timestamp > datetime() - duration({hours: $time_window})
        )
        WITH path,
             relationships(path) AS rels,
             nodes(path) AS intermediaries
        // Ensure temporal ordering
        WHERE ALL(i IN range(0, size(rels)-2) WHERE
            rels[i+1].timestamp >= rels[i].timestamp
        )
        RETURN [n IN intermediaries | n.address] AS path_addresses,
               size(rels) AS hop_count,
               [r IN rels | {
                   from: startNode(r).address,
                   to: endNode(r).address,
                   value: r.value,
                   timestamp: r.timestamp,
                   tx_hash: r.tx_hash
               }] AS transfers,
               reduce(total = 0.0, r IN rels | total + toFloat(r.value)) AS total_moved
        ORDER BY hop_count ASC
        LIMIT 10
        """
        return QueryResult(
            query=query.replace("$max_hops", str(max_hops)),
            params={
                "address": address,
                "time_window": time_window_hours,
            },
        )

    @staticmethod
    def detect_fan_out_fan_in(
        source_address: str,
        min_fan_out: int = 5,
        max_hops: int = 3,
    ) -> QueryResult:
        """
        Detect fan-out/fan-in pattern.

        Funds are spread to multiple addresses (fan-out) then
        collected to a single address (fan-in).
        """
        query = """
        // Find fan-out from source
        MATCH (source:Entity {address: $address})-[:TRANSFER]->(intermediate:Entity)
        WITH source, collect(DISTINCT intermediate) AS fan_out_nodes
        WHERE size(fan_out_nodes) >= $min_fan

        // Find where fan-out nodes converge
        UNWIND fan_out_nodes AS fan_node
        MATCH (fan_node)-[:TRANSFER*1..$max_hops]->(collector:Entity)
        WHERE collector <> source
        WITH source, fan_out_nodes, collector, count(DISTINCT fan_node) AS converging_count
        WHERE converging_count >= size(fan_out_nodes) * 0.5

        RETURN source.address AS source,
               [n IN fan_out_nodes | n.address] AS intermediaries,
               collector.address AS collector,
               converging_count AS converging_nodes,
               size(fan_out_nodes) AS total_fan_out
        ORDER BY converging_count DESC
        LIMIT 10
        """
        return QueryResult(
            query=query.replace("$max_hops", str(max_hops)),
            params={
                "address": source_address,
                "min_fan": min_fan_out,
            },
        )

    @staticmethod
    def detect_mixer_interaction(
        address: str,
        known_mixer_addresses: list[str] | None = None,
    ) -> QueryResult:
        """
        Detect interactions with known mixers.

        Identifies direct or indirect transactions with mixer contracts.
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
        // Direct mixer interactions
        MATCH (e:Entity {address: $address})-[r:TRANSFER]-(mixer:Entity)
        WHERE mixer.address IN $mixers
        WITH e, mixer, r, 1 AS hops

        UNION

        // 1-hop indirect interactions
        MATCH (e:Entity {address: $address})-[:TRANSFER]-(intermediate:Entity)
              -[r:TRANSFER]-(mixer:Entity)
        WHERE mixer.address IN $mixers
        AND intermediate.address <> e.address
        WITH e, mixer, r, 2 AS hops

        RETURN DISTINCT mixer.address AS mixer_address,
               hops AS distance,
               r.value AS value,
               r.timestamp AS timestamp,
               r.tx_hash AS tx_hash,
               CASE WHEN startNode(r).address = mixer.address
                    THEN 'withdrawal'
                    ELSE 'deposit'
               END AS direction
        ORDER BY hops ASC, timestamp DESC
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
        marked as high or critical risk.
        """
        query = """
        MATCH (source:Entity {address: $address})
        MATCH (risky:Entity)
        WHERE risky.risk_level IN ['high', 'critical']
        AND risky.address <> source.address
        MATCH path = shortestPath((source)-[:TRANSFER*1..$max_depth]->(risky))
        WITH path,
             risky,
             length(path) AS hops,
             relationships(path) AS rels
        RETURN risky.address AS high_risk_entity,
               risky.risk_level AS risk_level,
               risky.name AS entity_name,
               labels(risky) AS entity_labels,
               hops,
               [r IN rels | {
                   from: startNode(r).address,
                   to: endNode(r).address,
                   value: r.value,
                   tx_hash: r.tx_hash
               }] AS path_transfers
        ORDER BY hops ASC
        LIMIT 20
        """
        return QueryResult(
            query=query.replace("$max_depth", str(max_depth)),
            params={"address": source_address},
        )
