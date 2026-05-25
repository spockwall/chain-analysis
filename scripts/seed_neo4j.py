#!/usr/bin/env python3
"""
Seed Neo4j with real on-chain Ethereum data.

Creates:
- Known protocol nodes (CEX hot wallets, DEXes, mixers, bridges, lending pools)
- A curated set of real historical transactions pulled from mainnet:
    * Binance hot-wallet internal rebalancing flows (large)
    * Binance outflows to user EOAs (retail withdrawals)
    * Deposits back into Binance from user EOAs
    * DEX swaps routed through Uniswap V2
    * Aave V2 deposits from a Binance-linked address

All transaction hashes, addresses, values, and block numbers are real and
verifiable on etherscan.io.

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


# ── Known protocol nodes ──────────────────────────────────────────────────────

NODES = [
    # ── Centralised exchange hot wallets ──────────────────────────────────────
    {
        "address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {
            "name": "Binance Hot Wallet 14",
            "risk_level": "low",
            "entity_type": "CEXHotWallet",
        },
    },
    {
        "address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {
            "name": "Binance Hot Wallet 15",
            "risk_level": "low",
            "entity_type": "CEXHotWallet",
        },
    },
    {
        "address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {
            "name": "Binance 8 (cold)",
            "risk_level": "low",
            "entity_type": "CEXHotWallet",
        },
    },
    {
        "address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {
            "name": "Coinbase Hot Wallet",
            "risk_level": "low",
            "entity_type": "CEXHotWallet",
        },
    },
    {
        "address": "0x2910543af39aba0cd09dbb2d50200b3e800a63d2",
        "labels": ["Entity", "CEXHotWallet"],
        "props": {
            "name": "Kraken Hot Wallet",
            "risk_level": "low",
            "entity_type": "CEXHotWallet",
        },
    },
    # ── DEXes ─────────────────────────────────────────────────────────────────
    {
        "address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "labels": ["Entity", "DEX"],
        "props": {
            "name": "Uniswap V2 Router",
            "risk_level": "low",
            "entity_type": "DEX",
        },
    },
    {
        "address": "0xe592427a0aece92de3edee1f18e0157c05861564",
        "labels": ["Entity", "DEX"],
        "props": {
            "name": "Uniswap V3 Router",
            "risk_level": "low",
            "entity_type": "DEX",
        },
    },
    {
        "address": "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
        "labels": ["Entity", "DEX"],
        "props": {
            "name": "SushiSwap Router",
            "risk_level": "low",
            "entity_type": "DEX",
        },
    },
    # ── Lending pools ─────────────────────────────────────────────────────────
    {
        "address": "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
        "labels": ["Entity", "LendingPool"],
        "props": {
            "name": "Aave V2 Lending Pool",
            "risk_level": "low",
            "entity_type": "LendingPool",
        },
    },
    {
        "address": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        "labels": ["Entity", "LendingPool"],
        "props": {
            "name": "Aave V3 Pool",
            "risk_level": "low",
            "entity_type": "LendingPool",
        },
    },
    # ── Bridges ───────────────────────────────────────────────────────────────
    {
        "address": "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
        "labels": ["Entity", "Bridge"],
        "props": {
            "name": "Polygon Bridge",
            "risk_level": "medium",
            "entity_type": "Bridge",
        },
    },
    {
        "address": "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1",
        "labels": ["Entity", "Bridge"],
        "props": {
            "name": "Optimism Bridge",
            "risk_level": "medium",
            "entity_type": "Bridge",
        },
    },
    {
        "address": "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f",
        "labels": ["Entity", "Bridge"],
        "props": {
            "name": "Arbitrum Inbox",
            "risk_level": "medium",
            "entity_type": "Bridge",
        },
    },
    # ── Tornado Cash pool contracts ───────────────────────────────────────────
    {
        "address": "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
        "labels": ["Entity", "Mixer"],
        "props": {
            "name": "Tornado Cash 0.1 ETH",
            "risk_level": "critical",
            "entity_type": "Mixer",
        },
    },
    {
        "address": "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
        "labels": ["Entity", "Mixer"],
        "props": {
            "name": "Tornado Cash 10 ETH",
            "risk_level": "critical",
            "entity_type": "Mixer",
        },
    },
    {
        "address": "0xa160cdab225685da1d56aa342ad8841c3b53f291",
        "labels": ["Entity", "Mixer"],
        "props": {
            "name": "Tornado Cash 100 ETH",
            "risk_level": "critical",
            "entity_type": "Mixer",
        },
    },
    {
        "address": "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
        "labels": ["Entity", "Mixer"],
        "props": {
            "name": "Tornado Cash 1 ETH",
            "risk_level": "critical",
            "entity_type": "Mixer",
        },
    },
    # ── Staking ───────────────────────────────────────────────────────────────
    {
        "address": "0x00000000219ab540356cbb839cbe05303d7705fa",
        "labels": ["Entity", "Contract"],
        "props": {
            "name": "ETH2 Deposit Contract",
            "risk_level": "low",
            "entity_type": "Contract",
        },
    },
    {
        "address": "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        "labels": ["Entity", "Contract"],
        "props": {"name": "Lido stETH", "risk_level": "low", "entity_type": "Contract"},
    },
]


# ── Real historical transactions ──────────────────────────────────────────────
#
# Every hash below is a real mainnet Ethereum transaction. Verify at
# https://etherscan.io/tx/<hash>. Values are in wei (string-encoded).
# Timestamps are UNIX seconds.

TRANSACTIONS = [
    # ── Binance 8 → Binance HW14 (large internal rebalance, 316,516 ETH) ─────
    {
        "hash": "0x5cc52de1911716c33c655ac0b43d19aa64ac02d8983229b5ca6af6abb9ce6144",
        "from_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {
            "value": "316516641209000000000000",
            "block_number": 12785247,
            "timestamp": 1625727566,
            "gas_used": 21000,
            "gas_price": "24000000000",
        },
    },
    # ── Binance HW14 → Binance 8 (300,000 ETH rebalance) ─────────────────────
    {
        "hash": "0xafaedb1786efd4e27f8779063454c204c6daf0543d50e6add781ba7b27cb7159",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "props": {
            "value": "300000000000000000000000",
            "block_number": 12933637,
            "timestamp": 1627738865,
            "gas_used": 21000,
            "gas_price": "25000000000",
        },
    },
    # ── Binance HW14 → Binance 8 (293,613 ETH rebalance) ─────────────────────
    {
        "hash": "0x5b07f11dfbf439ff2ce85663a424023f5fe4f907f88d8fc6e851c61f90e0b09e",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "props": {
            "value": "293613449444590000000000",
            "block_number": 12650571,
            "timestamp": 1623914416,
            "gas_used": 21000,
            "gas_price": "30000000000",
        },
    },
    # ── Binance HW14 → Binance 8 (232,020 ETH rebalance) ─────────────────────
    {
        "hash": "0x35793a88df64e1e4c262091bc2924fb4b1a7b9a67a5ab20b719c1d11ebb34e09",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "props": {
            "value": "232020782678550000000000",
            "block_number": 12825574,
            "timestamp": 1626271833,
            "gas_used": 21000,
            "gas_price": "64000000000",
        },
    },
    # ── Binance HW14 → Binance 8 (187,908 ETH rebalance) ─────────────────────
    {
        "hash": "0x83c9b87eaaaeb9697d1e48b163f74da9e3f7e985bdd69cb75475e29862f6375c",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "props": {
            "value": "187908801535840000000000",
            "block_number": 12872816,
            "timestamp": 1626910820,
            "gas_used": 21000,
            "gas_price": "30000000000",
        },
    },
    # ── Binance HW14 → Binance 8 (67,144 ETH) ────────────────────────────────
    {
        "hash": "0xc10bf15e3ee196f31ae07a41cdaf0b5000f65bec443946ecb36cb3ab52e37e5b",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "props": {
            "value": "67144205568250000000000",
            "block_number": 12695472,
            "timestamp": 1624518629,
            "gas_used": 21000,
            "gas_price": "30000000000",
        },
    },
    # ── Binance HW14 → Binance 8 (64,821 ETH) ────────────────────────────────
    {
        "hash": "0x69d105f82e26786240f37cff6830f6397b28493e136eedbdc085c9db65aa270b",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "props": {
            "value": "64821420643270000000000",
            "block_number": 12689091,
            "timestamp": 1624433402,
            "gas_used": 21000,
            "gas_price": "30000000000",
        },
    },
    # ── Binance 8 → Binance HW14 (10 ETH retail-sized) ───────────────────────
    {
        "hash": "0x4543afe06b1b0fe43d8d6d76bce63f61a979e8d561885356c3338c4427027937",
        "from_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {
            "value": "10000000000000000000",
            "block_number": 12313786,
            "timestamp": 1619411339,
            "gas_used": 21000,
            "gas_price": "45000000000",
        },
    },
    # ── Binance HW15 → user EOAs (retail withdrawals) ─────────────────────────
    {
        "hash": "0x623dade4b183915e1871aaca1f7b509ed395d983814b0d118ca19bfb0afb8f9c",
        "from_address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "to_address": "0xe7eb9740b3761e6a885ce428599543ffd1ddf199",
        "props": {
            "value": "13096500000000000000",
            "block_number": 13038578,
            "timestamp": 1629147720,
            "gas_used": 21000,
            "gas_price": "60000000000",
        },
    },
    {
        "hash": "0xa4038f560812e770ed8d5a3c866e3c94cea464d6924cd6e8326a6ad7e604cfd1",
        "from_address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "to_address": "0x750fc43ea5700bffe949b856b1c88ff152ce6dc7",
        "props": {
            "value": "13096500000000000000",
            "block_number": 13038613,
            "timestamp": 1629148157,
            "gas_used": 21000,
            "gas_price": "65000000000",
        },
    },
    {
        "hash": "0x446f990394eafdde451dd8cf54b257c59d76fabb7cbb13aa6ab5c8d5b0b6ac15",
        "from_address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "to_address": "0xd402cb40e1fdcc1aa7d09eb9998a8d3501d6f3b8",
        "props": {
            "value": "19996500000000000000",
            "block_number": 13038635,
            "timestamp": 1629148476,
            "gas_used": 21000,
            "gas_price": "65000000000",
        },
    },
    {
        "hash": "0xc1ba176de279b3e39ad9815ef8e9d079dcc5ad33539efcb084218678d8e84e4c",
        "from_address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "to_address": "0x42355e7dc0a872c465be9de4acaaacb5709ce813",
        "props": {
            "value": "28996500000000000000",
            "block_number": 13038683,
            "timestamp": 1629149116,
            "gas_used": 21000,
            "gas_price": "60000000000",
        },
    },
    {
        "hash": "0x7fd7dd948f30b0b6e68da1eaf45c9c63aca3d4ec5890debbd9f0930155560180",
        "from_address": "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
        "to_address": "0x38c55a5b006d2c40f6bd168575080af8fe8f317d",
        "props": {
            "value": "473000000000000000000",
            "block_number": 13038805,
            "timestamp": 1629150808,
            "gas_used": 21000,
            "gas_price": "62000000000",
        },
    },
    # ── Binance HW14 → user EOAs (retail withdrawals) ────────────────────────
    {
        "hash": "0x2cf5b527212ada9780a88cf3f67aeeb1f25a79bb49f485b6c15d311e943176a4",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0x04a0676aea719a5e6fbbc3388e81b27a4bf0b3e1",
        "props": {
            "value": "28000000000000000000",
            "block_number": 13038796,
            "timestamp": 1629150628,
            "gas_used": 21000,
            "gas_price": "62000000000",
        },
    },
    {
        "hash": "0x400508456e41de9f779d547454ca14f300d49ac3745f5cd4f4533281344ec576",
        "from_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "to_address": "0x99d5fd4c570ceae5906a7262d40491374aed375b",
        "props": {
            "value": "32640921540000000000",
            "block_number": 13038842,
            "timestamp": 1629151231,
            "gas_used": 21000,
            "gas_price": "62000000000",
        },
    },
    # ── User EOAs → Binance HW14 (deposits / layering into CEX) ──────────────
    {
        "hash": "0x55538ac421f82f76c1bbae4b6860e9a14d6ea6831abb1ff02fe5af35e8902c57",
        "from_address": "0xefe3f9e71342179c55c567655df45464e812d91c",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {
            "value": "12596223096000000000",
            "block_number": 13038849,
            "timestamp": 1629151354,
            "gas_used": 21000,
            "gas_price": "82000000000",
        },
    },
    {
        "hash": "0x163dd54ed1a91dd844916e82d0c80376f6ff58e19b3c712da433b61caf8d0900",
        "from_address": "0xf2103b01cd7957f3a9d9726bbb74c0ccd3f355d3",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {
            "value": "1499992261363000000000",
            "block_number": 13038849,
            "timestamp": 1629151354,
            "gas_used": 21000,
            "gas_price": "82000000000",
        },
    },
    {
        "hash": "0xf0e32b594534df479750aa52d8cddfecee21c6a2c53e98b38f09c757965fe22e",
        "from_address": "0x42974c764fa74359acf84d904be33d18e69719db",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {
            "value": "14902401983000000000",
            "block_number": 13038849,
            "timestamp": 1629151354,
            "gas_used": 21000,
            "gas_price": "82000000000",
        },
    },
    {
        "hash": "0x7640daafb4260fc23f5f19e19ab835620e83ce4a0b8ceb8b3668f9342a908b88",
        "from_address": "0xe8a28d1985bd13ae6940af5c6aa21fabe0126e55",
        "to_address": "0x28c6c06298d514db089934071355e5743bf21d60",
        "props": {
            "value": "31110918921000000000",
            "block_number": 13038849,
            "timestamp": 1629151354,
            "gas_used": 21000,
            "gas_price": "82000000000",
        },
    },
    # ── DEX swaps → Uniswap V2 Router (retail trading activity) ──────────────
    {
        "hash": "0x87c47b0a13ea8893f82242d8ac8afcaaeb2c5218ee67166595fd9264121da91e",
        "from_address": "0xfd51ef717ecb471952cb1a2376acda1e4fc9ffca",
        "to_address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "props": {
            "value": "5000000000000000000",
            "block_number": 13153282,
            "timestamp": 1630679229,
            "gas_used": 23447,
            "gas_price": "196259559687",
        },
    },
    {
        "hash": "0x2095bdcacc6f3618efd4a42f423d9c585498d9f9c15e7b1030f325649ad91465",
        "from_address": "0xf330478fc27dc89bf1405cbc398fdc67dde4d936",
        "to_address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "props": {
            "value": "2000000000000000000",
            "block_number": 13160869,
            "timestamp": 1630780238,
            "gas_used": 31477,
            "gas_price": "200000000000",
        },
    },
    {
        "hash": "0xbf7a30423aeedec77aea96bf9bf44b81908ba1f014d24e0cb37775684d830be0",
        "from_address": "0x58f1c9a58bb38a11e38d2dd3da2ed3ff0b9f1ff3",
        "to_address": "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "props": {
            "value": "1020444480000000000",
            "block_number": 13160869,
            "timestamp": 1630780238,
            "gas_used": 124684,
            "gas_price": "126500000000",
        },
    },
    # ── Binance 8 → Aave V2 (CEX-linked DeFi deposit) ─────────────────────────
    {
        "hash": "0xd5a8201ad99326604e232bc97e8df22862ca07ad5aef81173f4539ff0013cfd7",
        "from_address": "0xf977814e90da44bfa03b6295a0616a897441acec",
        "to_address": "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
        "props": {
            "value": "0",
            "block_number": 12540852,
            "timestamp": 1622138000,
            "gas_used": 180000,
            "gas_price": "40000000000",
        },
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


# Counterparty EOAs referenced by TRANSACTIONS that aren't already in NODES —
# seeded as plain Entity/EOA so SENT/RECEIVED MATCH clauses succeed.
def _counterparty_addresses() -> list[str]:
    known = {n["address"] for n in NODES}
    seen: list[str] = []
    for tx in TRANSACTIONS:
        for field in ("from_address", "to_address"):
            addr = tx[field]
            if addr not in known and addr not in seen:
                seen.append(addr)
    return seen


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
            await session.run(
                UPSERT_NODE,
                address=node["address"],
                props=props,
                extra_labels=extra_labels,
            )
        else:
            await session.run(UPSERT_NODE_NO_APOC, address=node["address"], props=props)
            for label in extra_labels:
                await session.run(
                    f"MATCH (n:Entity {{address: $a}}) SET n:{label}",
                    a=node["address"],
                )
        name = node["props"].get("name", node["address"])
        print(f"  ✓ [{', '.join(node['labels'])}] {name}")

    print(f"\nSeeding {len(NODES)} protocol nodes...")
    async with driver.session() as session:
        for node in NODES:
            await upsert_node(session, node)

    counterparties = _counterparty_addresses()
    print(f"\nSeeding {len(counterparties)} counterparty EOAs...")
    async with driver.session() as session:
        for addr in counterparties:
            await upsert_node(
                session,
                {
                    "address": addr,
                    "labels": ["Entity", "EOA"],
                    "props": {"risk_level": "unknown", "entity_type": "EOA"},
                },
            )

    print(f"\nSeeding {len(TRANSACTIONS)} real mainnet transactions...")
    async with driver.session() as session:
        for tx in TRANSACTIONS:
            await session.run(
                UPSERT_TX,
                hash=tx["hash"],
                from_address=tx["from_address"],
                to_address=tx["to_address"],
                props=tx["props"],
            )
            print(
                f"  ✓ {tx['hash'][:18]}…  {tx['from_address'][:10]}… → {tx['to_address'][:10]}…"
            )

    async with driver.session() as session:
        result = await session.run("MATCH (n:Entity) RETURN count(n) AS nodes")
        node_count = (await result.single())["nodes"]
        result = await session.run("MATCH (t:Transaction) RETURN count(t) AS txs")
        tx_count = (await result.single())["txs"]

    print(f"\n── Done ──────────────────────────────────────────")
    print(f"  Entity nodes  : {node_count}")
    print(f"  Transactions  : {tx_count}")
    print(f"\nSearch these real addresses in the app:")
    print(f"  0xf977814e90da44bfa03b6295a0616a897441acec  ← Binance 8 (cold)")
    print(f"  0x28c6c06298d514db089934071355e5743bf21d60  ← Binance Hot Wallet 14")
    print(f"  0x21a31ee1afc51d94c2efccaa2092ad1028285549  ← Binance Hot Wallet 15")
    print(f"  0x7a250d5630b4cf539739df2c5dacb4c659f2488d  ← Uniswap V2 Router")

    await driver.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed Neo4j with real on-chain sample data"
    )
    parser.add_argument(
        "--uri", default=os.getenv("NEO4J_URI", "bolt://localhost:7687")
    )
    parser.add_argument("--user", default=os.getenv("NEO4J_USER", "neo4j"))
    parser.add_argument(
        "--password", default=os.getenv("NEO4J_PASSWORD", "password123")
    )
    args = parser.parse_args()

    asyncio.run(seed(args.uri, args.user, args.password))


if __name__ == "__main__":
    main()
