#!/usr/bin/env python3
"""
Seed Neo4j with a realistic AML investigation subgraph.

Creates:
- Known protocol nodes (CEX hot wallets, DEXes, mixers, bridges, lending pools)
- Group nodes (Tornado Cash Protocol, Uniswap Protocol) with MEMBER_OF contracts
- Depositor EOAs → Tornado Cash Protocol group (direct group-level transactions)
- Withdrawal EOAs ← Tornado Cash Protocol group (direct group-level transactions)
- A simulated peel-chain laundering pattern
- A fan-out structuring pattern

Run AFTER init_neo4j.py (constraints must exist first).

Usage:
    python scripts/seed_neo4j.py
    python scripts/seed_neo4j.py --uri bolt://localhost:7687 --password password123
"""

import asyncio
import argparse
import os
import sys
from pathlib import Path

_src_path = Path(__file__).parent.parent / "backend" / "src"
if _src_path.exists():
    sys.path.insert(0, str(_src_path))

from neo4j import AsyncGraphDatabase


# ── Seed data ─────────────────────────────────────────────────────────────────

NODES = [
    # ── Known protocols ───────────────────────────────────────────────────────
    {
        "address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {"name": "Binance Hot Wallet", "risk_level": "low", "entity_type": "CEXHotWallet"},
    },
    {
        "address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {"name": "Binance Hot Wallet 2", "risk_level": "low", "entity_type": "CEXHotWallet"},
    },
    {
        "address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {"name": "Coinbase Hot Wallet", "risk_level": "low", "entity_type": "CEXHotWallet"},
    },
    {
        "address": "0x2910543af39aba0cd09dbb2d50200b3e800a63d2",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {"name": "Kraken Hot Wallet", "risk_level": "low", "entity_type": "CEXHotWallet"},
    },
    {
        "address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "labels": ["Entity", "DEX"],
        "props": {"name": "Uniswap V2 Router", "risk_level": "low", "entity_type": "DEX"},
    },
    {
        "address": "0xe592427a0aece92de3edee1f18e0157c05861564",
        "labels": ["Entity", "DEX"],
        "props": {"name": "Uniswap V3 Router", "risk_level": "low", "entity_type": "DEX"},
    },
    {
        "address": "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
        "labels": ["Entity", "DEX"],
        "props": {"name": "SushiSwap Router", "risk_level": "low", "entity_type": "DEX"},
    },
    {
        "address": "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
        "labels": ["Entity", "LendingPool"],
        "props": {"name": "Aave V2 Lending Pool", "risk_level": "low", "entity_type": "LendingPool"},
    },
    {
        "address": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        "labels": ["Entity", "LendingPool"],
        "props": {"name": "Aave V3 Pool", "risk_level": "low", "entity_type": "LendingPool"},
    },
    {
        "address": "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
        "labels": ["Entity", "Bridge"],
        "props": {"name": "Polygon Bridge", "risk_level": "medium", "entity_type": "Bridge"},
    },
    {
        "address": "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1",
        "labels": ["Entity", "Bridge"],
        "props": {"name": "Optimism Bridge", "risk_level": "medium", "entity_type": "Bridge"},
    },
    {
        "address": "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f",
        "labels": ["Entity", "Bridge"],
        "props": {"name": "Arbitrum Inbox", "risk_level": "medium", "entity_type": "Bridge"},
    },
    # ── Tornado Cash pool contracts (members of TC Protocol group) ────────────
    {
        "address": "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
        "labels": ["Entity", "Mixer"],
        "props": {"name": "Tornado Cash 0.1 ETH", "risk_level": "critical", "entity_type": "Mixer"},
    },
    {
        "address": "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
        "labels": ["Entity", "Mixer"],
        "props": {"name": "Tornado Cash 10 ETH", "risk_level": "critical", "entity_type": "Mixer"},
    },
    {
        "address": "0xa160cdab225685da1d56aa342ad8841c3b53f291",
        "labels": ["Entity", "Mixer"],
        "props": {"name": "Tornado Cash 100 ETH", "risk_level": "critical", "entity_type": "Mixer"},
    },
    {
        "address": "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
        "labels": ["Entity", "Mixer"],
        "props": {"name": "Tornado Cash 1 ETH", "risk_level": "critical", "entity_type": "Mixer"},
    },
    # ── Staking ───────────────────────────────────────────────────────────────
    {
        "address": "0x00000000219ab540356cbb839cbe05303d7705fa",
        "labels": ["Entity", "Contract"],
        "props": {"name": "ETH2 Deposit Contract", "risk_level": "low", "entity_type": "Contract"},
    },
    {
        "address": "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        "labels": ["Entity", "Contract"],
        "props": {"name": "Lido stETH", "risk_level": "low", "entity_type": "Contract"},
    },

    # ── Peel chain wallets ────────────────────────────────────────────────────
    {
        "address": "0xaaaa000000000000000000000000000000000001",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Suspect Origin Wallet", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 12, "volume_out": "580000000000000000000"},
    },
    {
        "address": "0xaaaa000000000000000000000000000000000002",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Peel Hop 1", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "100000000000000000000",
                  "volume_out": "99000000000000000000"},
    },
    {
        "address": "0xaaaa000000000000000000000000000000000003",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Peel Hop 2", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "99000000000000000000",
                  "volume_out": "98000000000000000000"},
    },
    {
        "address": "0xaaaa000000000000000000000000000000000004",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Peel Hop 3 (exit)", "risk_level": "medium", "entity_type": "EOA",
                  "tx_count": 2},
    },

    # ── Tornado Cash depositors — send ETH directly to the TC Protocol group ──
    {
        "address": "0xdddd000000000000000000000000000000000001",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Depositor A", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 3, "volume_out": "300000000000000000"},
    },
    {
        "address": "0xdddd000000000000000000000000000000000002",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Depositor B", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 2, "volume_out": "2000000000000000000"},
    },
    {
        "address": "0xdddd000000000000000000000000000000000003",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Depositor C", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 1, "volume_out": "10000000000000000000"},
    },
    {
        "address": "0xdddd000000000000000000000000000000000004",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Depositor D (100 ETH)", "risk_level": "critical", "entity_type": "EOA",
                  "tx_count": 1, "volume_out": "100000000000000000000"},
    },
    {
        "address": "0xdddd000000000000000000000000000000000005",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Depositor E (CEX-linked)", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 1, "volume_out": "10000000000000000000"},
    },

    # ── Tornado Cash withdrawal wallets — receive from TC Protocol group ───────
    {
        "address": "0xeeee000000000000000000000000000000000001",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Withdraw Wallet A", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 1, "volume_in": "100000000000000000"},
    },
    {
        "address": "0xeeee000000000000000000000000000000000002",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Withdraw Wallet B", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 1, "volume_in": "100000000000000000"},
    },
    {
        "address": "0xeeee000000000000000000000000000000000003",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Withdraw Wallet C", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 1, "volume_in": "1000000000000000000"},
    },
    {
        "address": "0xeeee000000000000000000000000000000000004",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Withdraw Wallet D (→ Binance)", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "10000000000000000000"},
    },
    {
        "address": "0xeeee000000000000000000000000000000000005",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Withdraw Wallet E (→ Bridge)", "risk_level": "critical", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "100000000000000000000"},
    },
    {
        "address": "0xeeee000000000000000000000000000000000006",
        "labels": ["Entity", "EOA"],
        "props": {"name": "TC Withdraw Wallet F", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 1, "volume_in": "10000000000000000000"},
    },

    # ── Fan-out structuring wallets ───────────────────────────────────────────
    {
        "address": "0xbbbb000000000000000000000000000000000001",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Whale (structuring source)", "risk_level": "high", "entity_type": "EOA",
                  "tx_count": 5, "volume_out": "490000000000000000000"},
    },
    {
        "address": "0xbbbb000000000000000000000000000000000002",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Smurf 1", "risk_level": "medium", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "98000000000000000000"},
    },
    {
        "address": "0xbbbb000000000000000000000000000000000003",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Smurf 2", "risk_level": "medium", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "98000000000000000000"},
    },
    {
        "address": "0xbbbb000000000000000000000000000000000004",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Smurf 3", "risk_level": "medium", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "98000000000000000000"},
    },
    {
        "address": "0xbbbb000000000000000000000000000000000005",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Smurf 4", "risk_level": "medium", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "98000000000000000000"},
    },
    {
        "address": "0xbbbb000000000000000000000000000000000006",
        "labels": ["Entity", "EOA"],
        "props": {"name": "Smurf 5", "risk_level": "medium", "entity_type": "EOA",
                  "tx_count": 2, "volume_in": "98000000000000000000"},
    },
]


# ── Group parent nodes ─────────────────────────────────────────────────────────

GROUP_NODES = [
    {
        "address": "0xcccc000000000000000000000000000000000001",
        "labels": ["Entity", "Mixer"],
        "props": {
            "name": "Tornado Cash Protocol",
            "risk_level": "critical",
            "entity_type": "Mixer",
        },
    },
    {
        "address": "0xcccc000000000000000000000000000000000002",
        "labels": ["Entity", "DEX"],
        "props": {
            "name": "Uniswap Protocol",
            "risk_level": "low",
            "entity_type": "DEX",
        },
    },
]

# (parent_address, child_address) — child is MEMBER_OF parent
GROUP_MEMBERSHIPS = [
    # Tornado Cash Protocol → four deployed pool contracts
    ("0xcccc000000000000000000000000000000000001", "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b"),
    ("0xcccc000000000000000000000000000000000001", "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf"),
    ("0xcccc000000000000000000000000000000000001", "0xa160cdab225685da1d56aa342ad8841c3b53f291"),
    ("0xcccc000000000000000000000000000000000001", "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936"),
    # Uniswap Protocol → V2 and V3 routers
    ("0xcccc000000000000000000000000000000000002", "0x7a250d5630b4cf539739df2c5dacb4c659f2488d"),
    ("0xcccc000000000000000000000000000000000002", "0xe592427a0aece92de3edee1f18e0157c05861564"),
]

UPSERT_MEMBER_OF = """
MATCH (parent:Entity {address: $parent})
MATCH (child:Entity  {address: $child})
MERGE (child)-[:MEMBER_OF {added_at: $added_at}]->(parent)
"""

# The TC_GROUP address — transactions target/originate from the group node directly
TC_GROUP = "0xcccc000000000000000000000000000000000001"

TRANSACTIONS = [
    # ── Peel chain ────────────────────────────────────────────────────────────
    # Suspect → Tornado Cash 10 ETH (member contract — pre-group historical txs)
    {
        "hash": "0xaaa001",
        "from_address": "0xaaaa000000000000000000000000000000000001",
        "to_address": "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
        "props": {"value": "10000000000000000000", "block_number": 18000001},
    },
    {
        "hash": "0xaaa002",
        "from_address": "0xaaaa000000000000000000000000000000000001",
        "to_address": "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
        "props": {"value": "10000000000000000000", "block_number": 18000050},
    },
    # Tornado Cash 10 ETH → Peel Hop 1
    {
        "hash": "0xaaa003",
        "from_address": "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
        "to_address": "0xaaaa000000000000000000000000000000000002",
        "props": {"value": "100000000000000000000", "block_number": 18001000},
    },
    # Hop 1 → Hop 2
    {
        "hash": "0xaaa004",
        "from_address": "0xaaaa000000000000000000000000000000000002",
        "to_address": "0xaaaa000000000000000000000000000000000003",
        "props": {"value": "99000000000000000000", "block_number": 18001100},
    },
    # Hop 2 → Hop 3
    {
        "hash": "0xaaa005",
        "from_address": "0xaaaa000000000000000000000000000000000003",
        "to_address": "0xaaaa000000000000000000000000000000000004",
        "props": {"value": "98000000000000000000", "block_number": 18001200},
    },
    # Hop 3 exits to Binance
    {
        "hash": "0xaaa006",
        "from_address": "0xaaaa000000000000000000000000000000000004",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {"value": "97000000000000000000", "block_number": 18001300},
    },
    # Suspect also uses Uniswap (layering)
    {
        "hash": "0xaaa007",
        "from_address": "0xaaaa000000000000000000000000000000000001",
        "to_address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "props": {"value": "50000000000000000000", "block_number": 18000200},
    },
    # Hop 3 also re-deposits into TC 100 ETH (double-mixer)
    {
        "hash": "0xaaa010",
        "from_address": "0xaaaa000000000000000000000000000000000004",
        "to_address": "0xa160cdab225685da1d56aa342ad8841c3b53f291",
        "props": {"value": "100000000000000000000", "block_number": 18002000},
    },

    # ── Fan-out structuring ───────────────────────────────────────────────────
    {
        "hash": "0xbbb001",
        "from_address": "0xbbbb000000000000000000000000000000000001",
        "to_address": "0xbbbb000000000000000000000000000000000002",
        "props": {"value": "98000000000000000000", "block_number": 18002001},
    },
    {
        "hash": "0xbbb002",
        "from_address": "0xbbbb000000000000000000000000000000000001",
        "to_address": "0xbbbb000000000000000000000000000000000003",
        "props": {"value": "98000000000000000000", "block_number": 18002002},
    },
    {
        "hash": "0xbbb003",
        "from_address": "0xbbbb000000000000000000000000000000000001",
        "to_address": "0xbbbb000000000000000000000000000000000004",
        "props": {"value": "98000000000000000000", "block_number": 18002003},
    },
    {
        "hash": "0xbbb004",
        "from_address": "0xbbbb000000000000000000000000000000000001",
        "to_address": "0xbbbb000000000000000000000000000000000005",
        "props": {"value": "98000000000000000000", "block_number": 18002004},
    },
    {
        "hash": "0xbbb005",
        "from_address": "0xbbbb000000000000000000000000000000000001",
        "to_address": "0xbbbb000000000000000000000000000000000006",
        "props": {"value": "98000000000000000000", "block_number": 18002005},
    },
    # All smurfs deposit into Coinbase (fan-in)
    {
        "hash": "0xbbb011",
        "from_address": "0xbbbb000000000000000000000000000000000002",
        "to_address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "props": {"value": "97000000000000000000", "block_number": 18003001},
    },
    {
        "hash": "0xbbb012",
        "from_address": "0xbbbb000000000000000000000000000000000003",
        "to_address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "props": {"value": "97000000000000000000", "block_number": 18003002},
    },
    {
        "hash": "0xbbb013",
        "from_address": "0xbbbb000000000000000000000000000000000004",
        "to_address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "props": {"value": "97000000000000000000", "block_number": 18003003},
    },
    {
        "hash": "0xbbb014",
        "from_address": "0xbbbb000000000000000000000000000000000005",
        "to_address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "props": {"value": "97000000000000000000", "block_number": 18003004},
    },
    {
        "hash": "0xbbb015",
        "from_address": "0xbbbb000000000000000000000000000000000006",
        "to_address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "props": {"value": "97000000000000000000", "block_number": 18003005},
    },
    # Whale uses Aave (obscure source)
    {
        "hash": "0xbbb020",
        "from_address": "0xbbbb000000000000000000000000000000000001",
        "to_address": "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
        "props": {"value": "200000000000000000000", "block_number": 18001500},
    },

    # ── Deposits → Tornado Cash Protocol group node ───────────────────────────
    # Depositor A — three 0.1 ETH deposits
    {
        "hash": "0xdd0001",
        "from_address": "0xdddd000000000000000000000000000000000001",
        "to_address": TC_GROUP,
        "props": {"value": "100000000000000000", "block_number": 18100001,
                  "gas_used": 21000, "gas_price": "20000000000"},
    },
    {
        "hash": "0xdd0002",
        "from_address": "0xdddd000000000000000000000000000000000001",
        "to_address": TC_GROUP,
        "props": {"value": "100000000000000000", "block_number": 18100050,
                  "gas_used": 21000, "gas_price": "20000000000"},
    },
    {
        "hash": "0xdd0003",
        "from_address": "0xdddd000000000000000000000000000000000001",
        "to_address": TC_GROUP,
        "props": {"value": "100000000000000000", "block_number": 18100100,
                  "gas_used": 21000, "gas_price": "20000000000"},
    },
    # Depositor B — two 1 ETH deposits
    {
        "hash": "0xdd0004",
        "from_address": "0xdddd000000000000000000000000000000000002",
        "to_address": TC_GROUP,
        "props": {"value": "1000000000000000000", "block_number": 18100200,
                  "gas_used": 21000, "gas_price": "25000000000"},
    },
    {
        "hash": "0xdd0005",
        "from_address": "0xdddd000000000000000000000000000000000002",
        "to_address": TC_GROUP,
        "props": {"value": "1000000000000000000", "block_number": 18100300,
                  "gas_used": 21000, "gas_price": "25000000000"},
    },
    # Depositor C — 10 ETH deposit
    {
        "hash": "0xdd0006",
        "from_address": "0xdddd000000000000000000000000000000000003",
        "to_address": TC_GROUP,
        "props": {"value": "10000000000000000000", "block_number": 18100400,
                  "gas_used": 21000, "gas_price": "30000000000"},
    },
    # Depositor D — 100 ETH deposit (critical amount)
    {
        "hash": "0xdd0007",
        "from_address": "0xdddd000000000000000000000000000000000004",
        "to_address": TC_GROUP,
        "props": {"value": "100000000000000000000", "block_number": 18100500,
                  "gas_used": 21000, "gas_price": "28000000000"},
    },
    # Depositor E — 10 ETH deposit (CEX-linked source)
    {
        "hash": "0xdd0008",
        "from_address": "0xdddd000000000000000000000000000000000005",
        "to_address": TC_GROUP,
        "props": {"value": "10000000000000000000", "block_number": 18100600,
                  "gas_used": 21000, "gas_price": "22000000000"},
    },

    # ── Withdrawals ← Tornado Cash Protocol group node ────────────────────────
    {
        "hash": "0xww0001",
        "from_address": TC_GROUP,
        "to_address": "0xeeee000000000000000000000000000000000001",
        "props": {"value": "100000000000000000", "block_number": 18105001,
                  "gas_used": 21000, "gas_price": "18000000000"},
    },
    {
        "hash": "0xww0002",
        "from_address": TC_GROUP,
        "to_address": "0xeeee000000000000000000000000000000000002",
        "props": {"value": "100000000000000000", "block_number": 18105100,
                  "gas_used": 21000, "gas_price": "18000000000"},
    },
    {
        "hash": "0xww0003",
        "from_address": TC_GROUP,
        "to_address": "0xeeee000000000000000000000000000000000003",
        "props": {"value": "1000000000000000000", "block_number": 18105200,
                  "gas_used": 21000, "gas_price": "20000000000"},
    },
    {
        "hash": "0xww0004",
        "from_address": TC_GROUP,
        "to_address": "0xeeee000000000000000000000000000000000004",
        "props": {"value": "10000000000000000000", "block_number": 18105300,
                  "gas_used": 21000, "gas_price": "22000000000"},
    },
    {
        "hash": "0xww0005",
        "from_address": TC_GROUP,
        "to_address": "0xeeee000000000000000000000000000000000005",
        "props": {"value": "100000000000000000000", "block_number": 18105400,
                  "gas_used": 21000, "gas_price": "25000000000"},
    },
    {
        "hash": "0xww0006",
        "from_address": TC_GROUP,
        "to_address": "0xeeee000000000000000000000000000000000006",
        "props": {"value": "10000000000000000000", "block_number": 18105500,
                  "gas_used": 21000, "gas_price": "22000000000"},
    },

    # ── Post-withdrawal exit flows ────────────────────────────────────────────
    # Wallet E immediately bridges to Polygon (rapid exit)
    {
        "hash": "0xex0001",
        "from_address": "0xeeee000000000000000000000000000000000005",
        "to_address": "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
        "props": {"value": "99000000000000000000", "block_number": 18105450,
                  "gas_used": 21000, "gas_price": "25000000000"},
    },
    # Wallet D cashes out to Binance
    {
        "hash": "0xex0002",
        "from_address": "0xeeee000000000000000000000000000000000004",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {"value": "9900000000000000000", "block_number": 18105350,
                  "gas_used": 21000, "gas_price": "22000000000"},
    },
]


# ── Neo4j write helpers ────────────────────────────────────────────────────────

UPSERT_NODE = """
MERGE (n:Entity {address: $address})
SET n += $props
WITH n
CALL apoc.create.addLabels(n, $extra_labels) YIELD node
RETURN count(node) AS count
"""

UPSERT_NODE_NO_APOC = """
MERGE (n:Entity {address: $address})
SET n += $props
RETURN count(n) AS count
"""

UPSERT_TX = """
MERGE (t:Transaction {hash: $hash})
SET t += $props,
    t.from_address = $from_address,
    t.to_address   = $to_address
WITH t
MATCH (from:Entity {address: $from_address})
MATCH (to:Entity   {address: $to_address})
MERGE (from)-[:SENT]->(t)
MERGE (t)-[:RECEIVED]->(to)
RETURN count(t) AS count
"""


async def seed(uri: str, user: str, password: str) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=(user, password))

    async with driver.session() as session:
        try:
            await session.run("RETURN apoc.version()")
            has_apoc = True
        except Exception:
            has_apoc = False

    print(f"APOC available: {has_apoc}")

    async def upsert_node(session, node: dict) -> None:
        extra_labels = [l for l in node["labels"] if l != "Entity"]
        props = {**node["props"], "address": node["address"]}
        if has_apoc:
            await session.run(UPSERT_NODE, address=node["address"], props=props, extra_labels=extra_labels)
        else:
            await session.run(UPSERT_NODE_NO_APOC, address=node["address"], props=props)
            for label in extra_labels:
                await session.run(
                    f"MATCH (n:Entity {{address: $a}}) SET n:{label}",
                    a=node["address"],
                )
        name = node["props"].get("name", node["address"])
        print(f"  ✓ [{', '.join(node['labels'])}] {name}")

    print(f"\nSeeding {len(NODES)} entity nodes...")
    async with driver.session() as session:
        for node in NODES:
            await upsert_node(session, node)

    print(f"\nSeeding {len(TRANSACTIONS)} transactions...")
    async with driver.session() as session:
        for tx in TRANSACTIONS:
            await session.run(
                UPSERT_TX,
                hash=tx["hash"],
                from_address=tx["from_address"],
                to_address=tx["to_address"],
                props=tx["props"],
            )
            print(f"  ✓ {tx['hash']}  {tx['from_address'][:10]}… → {tx['to_address'][:10]}…")

    print(f"\nSeeding {len(GROUP_NODES)} group nodes...")
    async with driver.session() as session:
        for node in GROUP_NODES:
            await upsert_node(session, node)

    print(f"\nSeeding {len(GROUP_MEMBERSHIPS)} MEMBER_OF relationships...")
    added_at = "2024-01-01T00:00:00+00:00"
    async with driver.session() as session:
        for parent_addr, child_addr in GROUP_MEMBERSHIPS:
            await session.run(UPSERT_MEMBER_OF, parent=parent_addr, child=child_addr, added_at=added_at)
            print(f"  ✓ {child_addr[:18]}… → MEMBER_OF → {parent_addr[:18]}…")

    async with driver.session() as session:
        result = await session.run("MATCH (n:Entity) RETURN count(n) AS nodes")
        node_count = (await result.single())["nodes"]
        result = await session.run("MATCH (t:Transaction) RETURN count(t) AS txs")
        tx_count = (await result.single())["txs"]

    print(f"\n── Done ──────────────────────────────────────────")
    print(f"  Entity nodes  : {node_count}")
    print(f"  Transactions  : {tx_count}")
    print(f"\nSearch these addresses in the app:")
    print(f"  0xcccc000000000000000000000000000000000001  ← Tornado Cash Protocol group (5 depositors, 6 withdrawers)")
    print(f"  0xcccc000000000000000000000000000000000002  ← Uniswap Protocol group")
    print(f"  0xaaaa000000000000000000000000000000000001  ← Suspect peel-chain wallet")
    print(f"  0xbbbb000000000000000000000000000000000001  ← Whale structuring wallet")

    await driver.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed Neo4j with AML sample data")
    parser.add_argument("--uri", default=os.getenv("NEO4J_URI", "bolt://localhost:7687"))
    parser.add_argument("--user", default=os.getenv("NEO4J_USER", "neo4j"))
    parser.add_argument("--password", default=os.getenv("NEO4J_PASSWORD", "password123"))
    args = parser.parse_args()

    asyncio.run(seed(args.uri, args.user, args.password))


if __name__ == "__main__":
    main()
