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

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

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
        # Indexes for Edge Properties
        # =================================================================

        # Index on TRANSFER value for sorting/filtering
        await session.run("""
            CREATE INDEX transfer_value IF NOT EXISTS
            FOR ()-[r:TRANSFER]-() ON (r.value)
        """)
        print("  ✓ transfer_value index")

        # Index on TRANSFER timestamp for temporal queries
        await session.run("""
            CREATE INDEX transfer_timestamp IF NOT EXISTS
            FOR ()-[r:TRANSFER]-() ON (r.timestamp)
        """)
        print("  ✓ transfer_timestamp index")

        # Index on TRANSFER block_number for range queries
        await session.run("""
            CREATE INDEX transfer_block IF NOT EXISTS
            FOR ()-[r:TRANSFER]-() ON (r.block_number)
        """)
        print("  ✓ transfer_block index")

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
