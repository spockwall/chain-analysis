#!/usr/bin/env python3
"""
Seed the known_labels table with common blockchain entities.

This script populates the database with well-known addresses for:
- Major exchanges (Binance, Coinbase, etc.)
- DeFi protocols (Uniswap, Aave, etc.)
- Known mixers (Tornado Cash)
- Bridges

Usage:
    python scripts/seed_known_labels.py
"""

import asyncio
import sys
from pathlib import Path

_backend_path = Path(__file__).parent.parent / "backend"
if _backend_path.exists():
    sys.path.insert(0, str(_backend_path))

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Known labels data (Ethereum mainnet)
KNOWN_LABELS = [
    # =================================================================
    # Centralized Exchanges
    # =================================================================
    {
        "address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "name": "Binance Hot Wallet",
        "entity_type": "CEXHotWallet",
        "category": "exchange",
        "subcategory": "cex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "name": "Binance Hot Wallet 2",
        "entity_type": "CEXHotWallet",
        "category": "exchange",
        "subcategory": "cex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43",
        "name": "Coinbase Commerce",
        "entity_type": "CEXHotWallet",
        "category": "exchange",
        "subcategory": "cex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "name": "Coinbase Hot Wallet",
        "entity_type": "CEXHotWallet",
        "category": "exchange",
        "subcategory": "cex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0x2910543af39aba0cd09dbb2d50200b3e800a63d2",
        "name": "Kraken Hot Wallet",
        "entity_type": "CEXHotWallet",
        "category": "exchange",
        "subcategory": "cex",
        "risk_level": "low",
        "source": "etherscan",
    },
    # =================================================================
    # DEXes
    # =================================================================
    {
        "address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "name": "Uniswap V2 Router",
        "entity_type": "DEX",
        "category": "defi",
        "subcategory": "dex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0xe592427a0aece92de3edee1f18e0157c05861564",
        "name": "Uniswap V3 Router",
        "entity_type": "DEX",
        "category": "defi",
        "subcategory": "dex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
        "name": "SushiSwap Router",
        "entity_type": "DEX",
        "category": "defi",
        "subcategory": "dex",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0xdef1c0ded9bec7f1a1670819833240f027b25eff",
        "name": "0x Exchange Proxy",
        "entity_type": "DEX",
        "category": "defi",
        "subcategory": "dex_aggregator",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0x1111111254fb6c44bac0bed2854e76f90643097d",
        "name": "1inch Router V4",
        "entity_type": "DEX",
        "category": "defi",
        "subcategory": "dex_aggregator",
        "risk_level": "low",
        "source": "etherscan",
    },
    # =================================================================
    # Lending Protocols
    # =================================================================
    {
        "address": "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
        "name": "Aave V2 Lending Pool",
        "entity_type": "LendingPool",
        "category": "defi",
        "subcategory": "lending",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        "name": "Aave V3 Pool",
        "entity_type": "LendingPool",
        "category": "defi",
        "subcategory": "lending",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b",
        "name": "Compound Comptroller",
        "entity_type": "LendingPool",
        "category": "defi",
        "subcategory": "lending",
        "risk_level": "low",
        "source": "etherscan",
    },
    # =================================================================
    # Bridges
    # =================================================================
    {
        "address": "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
        "name": "Polygon Bridge",
        "entity_type": "Bridge",
        "category": "bridge",
        "subcategory": "l2_bridge",
        "risk_level": "medium",
        "source": "etherscan",
    },
    {
        "address": "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1",
        "name": "Optimism Bridge",
        "entity_type": "Bridge",
        "category": "bridge",
        "subcategory": "l2_bridge",
        "risk_level": "medium",
        "source": "etherscan",
    },
    {
        "address": "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f",
        "name": "Arbitrum Inbox",
        "entity_type": "Bridge",
        "category": "bridge",
        "subcategory": "l2_bridge",
        "risk_level": "medium",
        "source": "etherscan",
    },
    # =================================================================
    # Mixers (High Risk)
    # =================================================================
    {
        "address": "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
        "name": "Tornado Cash 0.1 ETH",
        "entity_type": "Mixer",
        "category": "mixer",
        "subcategory": "tornado_cash",
        "risk_level": "critical",
        "source": "etherscan",
    },
    {
        "address": "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
        "name": "Tornado Cash 10 ETH",
        "entity_type": "Mixer",
        "category": "mixer",
        "subcategory": "tornado_cash",
        "risk_level": "critical",
        "source": "etherscan",
    },
    {
        "address": "0xa160cdab225685da1d56aa342ad8841c3b53f291",
        "name": "Tornado Cash 100 ETH",
        "entity_type": "Mixer",
        "category": "mixer",
        "subcategory": "tornado_cash",
        "risk_level": "critical",
        "source": "etherscan",
    },
    {
        "address": "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
        "name": "Tornado Cash 1 ETH",
        "entity_type": "Mixer",
        "category": "mixer",
        "subcategory": "tornado_cash",
        "risk_level": "critical",
        "source": "etherscan",
    },
    # =================================================================
    # Staking
    # =================================================================
    {
        "address": "0x00000000219ab540356cbb839cbe05303d7705fa",
        "name": "ETH2 Deposit Contract",
        "entity_type": "Contract",
        "category": "staking",
        "subcategory": "eth2",
        "risk_level": "low",
        "source": "etherscan",
    },
    {
        "address": "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        "name": "Lido stETH",
        "entity_type": "Contract",
        "category": "staking",
        "subcategory": "liquid_staking",
        "risk_level": "low",
        "source": "etherscan",
    },
]


async def seed_known_labels(database_url: str) -> None:
    """Seed the known_labels table."""
    engine = create_async_engine(database_url)

    async with engine.begin() as conn:
        print("Seeding known labels...")

        for label in KNOWN_LABELS:
            # Use INSERT ... ON CONFLICT DO UPDATE for idempotency
            await conn.execute(
                text("""
                    INSERT INTO known_labels (
                        address, chain_id, name, entity_type, category,
                        subcategory, risk_level, source, verified
                    ) VALUES (
                        :address, 1, :name, :entity_type, :category,
                        :subcategory, :risk_level, :source, true
                    )
                    ON CONFLICT (address, chain_id)
                    DO UPDATE SET
                        name = EXCLUDED.name,
                        entity_type = EXCLUDED.entity_type,
                        category = EXCLUDED.category,
                        subcategory = EXCLUDED.subcategory,
                        risk_level = EXCLUDED.risk_level,
                        updated_at = NOW()
                """),
                label,
            )
            print(f"  ✓ {label['name']}")

        print(f"\nSeeded {len(KNOWN_LABELS)} known labels")

    await engine.dispose()


async def verify_seed(database_url: str) -> None:
    """Verify the seed was successful."""
    engine = create_async_engine(database_url)

    async with engine.begin() as conn:
        result = await conn.execute(
            text("SELECT category, COUNT(*) as count FROM known_labels GROUP BY category")
        )
        rows = result.fetchall()

        print("\nKnown labels by category:")
        for row in rows:
            print(f"  {row[0]}: {row[1]}")

    await engine.dispose()


def main() -> None:
    """Main entry point."""
    import argparse
    import os

    parser = argparse.ArgumentParser(description="Seed known labels")
    parser.add_argument(
        "--database-url",
        default=os.getenv(
            "DATABASE_URL",
            "postgresql+asyncpg://postgres:postgres123@localhost:5432/chain_analysis",
        ),
        help="Database URL",
    )
    parser.add_argument("--verify", action="store_true", help="Verify after seeding")
    args = parser.parse_args()

    asyncio.run(seed_known_labels(args.database_url))

    if args.verify:
        asyncio.run(verify_seed(args.database_url))


if __name__ == "__main__":
    main()
