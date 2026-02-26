#!/usr/bin/env python3
"""
Initialize Neo4j database with constraints and indexes.

Run this script after Neo4j is started to create the required schema.

Usage:
    python scripts/init_neo4j.py
"""

import asyncio
import sys
from pathlib import Path

# Allow running from the repo root (outside Docker) or inside the container
_backend_path = Path(__file__).parent.parent / "backend"
if _backend_path.exists():
    sys.path.insert(0, str(_backend_path))

from neo4j import AsyncGraphDatabase


async def init_neo4j(
    uri: str = "bolt://localhost:7687",
    user: str = "neo4j",
    password: str = "password123",
) -> None:
    """Initialize Neo4j with constraints and indexes."""
    driver = AsyncGraphDatabase.driver(uri, auth=(user, password))

    async with driver.session() as session:
        print("Initializing Neo4j schema...")

        # =================================================================
        # Constraints
        # =================================================================
        print("Creating constraints...")

        # Unique constraint on Entity address
        await session.run("""
            CREATE CONSTRAINT entity_address IF NOT EXISTS
            FOR (e:Entity) REQUIRE e.address IS UNIQUE
        """)
        print("  ✓ entity_address constraint")

        # =================================================================
        # Indexes for Node Properties
        # =================================================================
        print("Creating indexes...")

        # Index on entity type for filtering
        await session.run("""
            CREATE INDEX entity_type IF NOT EXISTS
            FOR (e:Entity) ON (e.entity_type)
        """)
        print("  ✓ entity_type index")

        # Index on risk level for filtering
        await session.run("""
            CREATE INDEX entity_risk IF NOT EXISTS
            FOR (e:Entity) ON (e.risk_level)
        """)
        print("  ✓ entity_risk index")

        # Index on first_seen for temporal queries
        await session.run("""
            CREATE INDEX entity_first_seen IF NOT EXISTS
            FOR (e:Entity) ON (e.first_seen)
        """)
        print("  ✓ entity_first_seen index")

        # Composite index for common query patterns
        await session.run("""
            CREATE INDEX entity_type_risk IF NOT EXISTS
            FOR (e:Entity) ON (e.entity_type, e.risk_level)
        """)
        print("  ✓ entity_type_risk composite index")

        # =================================================================
        # Transaction Node Constraint and Indexes
        # =================================================================

        # Unique constraint on Transaction hash
        await session.run("""
            CREATE CONSTRAINT tx_hash IF NOT EXISTS
            FOR (t:Transaction) REQUIRE t.hash IS UNIQUE
        """)
        print("  ✓ tx_hash unique constraint")

        # Index on block_number for range queries
        await session.run("""
            CREATE INDEX tx_block IF NOT EXISTS
            FOR (t:Transaction) ON (t.block_number)
        """)
        print("  ✓ tx_block index")

        # Index on timestamp for temporal queries
        await session.run("""
            CREATE INDEX tx_ts IF NOT EXISTS
            FOR (t:Transaction) ON (t.timestamp)
        """)
        print("  ✓ tx_ts index")

        # Index on value for sorting/filtering
        await session.run("""
            CREATE INDEX tx_value IF NOT EXISTS
            FOR (t:Transaction) ON (t.value)
        """)
        print("  ✓ tx_value index")

        # Index on from_address for direct sender lookups (e.g. "all txs sent by X")
        await session.run("""
            CREATE INDEX tx_from IF NOT EXISTS
            FOR (t:Transaction) ON (t.from_address)
        """)
        print("  ✓ tx_from index")

        # Index on to_address for direct receiver lookups (e.g. "all txs received by X")
        await session.run("""
            CREATE INDEX tx_to IF NOT EXISTS
            FOR (t:Transaction) ON (t.to_address)
        """)
        print("  ✓ tx_to index")

        # =================================================================
        # IN_GROUP Relationship Index
        # =================================================================

        # Index on IN_GROUP added_at for temporal membership queries.
        # NOTE: the old index was named member_of_added_at and targeted MEMBER_OF,
        # which was the previous relationship type. The schema now uses IN_GROUP.
        # If upgrading from an old instance, drop member_of_added_at manually:
        #   DROP INDEX member_of_added_at IF EXISTS
        await session.run("""
            CREATE INDEX in_group_added_at IF NOT EXISTS
            FOR ()-[r:IN_GROUP]-() ON (r.added_at)
        """)
        print("  ✓ in_group_added_at index")

        # =================================================================
        # Full-text Search Index (optional, for entity name search)
        # =================================================================
        try:
            await session.run("""
                CREATE FULLTEXT INDEX entity_name_search IF NOT EXISTS
                FOR (e:Entity) ON EACH [e.name, e.label]
            """)
            print("  ✓ entity_name_search fulltext index")
        except Exception as e:
            print(f"  ⚠ Skipping fulltext index: {e}")

        print("\nNeo4j schema initialization complete!")

    await driver.close()


async def verify_schema(
    uri: str = "bolt://localhost:7687",
    user: str = "neo4j",
    password: str = "password123",
) -> None:
    """Verify the schema was created correctly."""
    driver = AsyncGraphDatabase.driver(uri, auth=(user, password))

    async with driver.session() as session:
        print("\nVerifying schema...")

        # Check constraints
        result = await session.run("SHOW CONSTRAINTS")
        constraints = await result.data()
        print(f"  Constraints: {len(constraints)}")

        # Check indexes
        result = await session.run("SHOW INDEXES")
        indexes = await result.data()
        print(f"  Indexes: {len(indexes)}")

    await driver.close()


def main() -> None:
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="Initialize Neo4j schema")
    parser.add_argument("--uri", default="bolt://localhost:7687", help="Neo4j URI")
    parser.add_argument("--user", default="neo4j", help="Neo4j username")
    parser.add_argument("--password", default="password123", help="Neo4j password")
    parser.add_argument("--verify", action="store_true", help="Verify schema after creation")
    args = parser.parse_args()

    asyncio.run(init_neo4j(args.uri, args.user, args.password))

    if args.verify:
        asyncio.run(verify_schema(args.uri, args.user, args.password))


if __name__ == "__main__":
    main()
