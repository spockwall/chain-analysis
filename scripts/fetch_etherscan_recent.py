#!/usr/bin/env python
"""
Fetch recent transactions from the latest block on Etherscan and insert them into the partitioned raw_transactions PostgreSQL table.

Usage:
  python fetch_etherscan_recent.py --api-key YOUR_ETHERSCAN_KEY --count 30
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal

import httpx

# Add backend directory to sys.path so we can import the database models
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "backend"))

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.dialects.postgresql import insert
import structlog

# Set up simple logging
logger = structlog.get_logger()

# We need to import our raw transaction model
from src.db.models import RawTransaction


async def fetch_recent_transactions(api_key: str, count: int = 30) -> list[dict]:
    """Retrieve recent transactions from recent Ethereum blocks."""
    url = "https://api.etherscan.io/v2/api"
    formatted_txs = []
    
    logger.info("Fetching latest block number from Etherscan...")
    
    # 1. Get the very latest block number
    latest_block_params = {
        "chainid": 1,
        "module": "proxy",
        "action": "eth_blockNumber",
        "apikey": api_key,
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=latest_block_params, timeout=30.0)
        response.raise_for_status()
        latest_block_hex = response.json().get("result")
        if not latest_block_hex:
            logger.error(f"Failed to get latest block: {response.json()}")
            return []
            
        latest_block_num = int(latest_block_hex, 16)
        logger.info(f"Targeting up to {count} transactions, starting backwards from block {latest_block_num}")

        # 2. Loop backwards through blocks until we hit our target count
        current_block = latest_block_num
        
        while len(formatted_txs) < count:
            block_hex = hex(current_block)
            
            params = {
                "chainid": 1,
                "module": "proxy",
                "action": "eth_getBlockByNumber",
                "tag": block_hex,
                "boolean": "true",
                "apikey": api_key,
            }
            
            logger.info(f"Fetching block {current_block}...")
            response = await client.get(url, params=params, timeout=30.0)
            
            # General approach: If we hit a rate limit (429 or Etherscan's specific error payload), 
            # we log it, back off dynamically, and try the exact same request again.
            if response.status_code == 429:
                logger.warning("Rate limit hit (HTTP 429). Retrying in 1 second...")
                await asyncio.sleep(1)
                continue
                
            response.raise_for_status()
            data = response.json()
            
            # Etherscan often returns 200 OK but with a rate limit message inside the JSON body
            if isinstance(data, str) and "Max rate limit reached" in data:
                logger.warning("Etherscan API rate limit reached. Retrying in 1 second...")
                await asyncio.sleep(1)
                continue
            if data.get("status") == "0" and "rate limit" in str(data.get("message")).lower():
                logger.warning("Etherscan API rate limit reached. Retrying in 1 second...")
                await asyncio.sleep(1)
                continue
            
            result = data.get("result")
            
            if not result:
                logger.warning(f"Empty result for block {current_block}, skipping.")
                current_block -= 1
                continue
                
            # SOMETIMES Etherscan's "result" is mistakenly a string with an error message instead of a dictionary
            if isinstance(result, str):
                if "rate limit" in result.lower():
                    logger.warning(f"Rate limit reached in result. Retrying in 1 second...")
                    await asyncio.sleep(1)
                    continue
                else:
                    logger.error(f"Unexpected string result for block {current_block}: {result}")
                    current_block -= 1
                    continue
                    
            transactions = result.get("transactions", [])
            block_timestamp = int(result.get("timestamp", "0x0"), 16)
            
            logger.info(f"Block {current_block} has {len(transactions)} txs. (Total collected: {len(formatted_txs) + len(transactions)}/{count})")
            
            for tx in transactions:
                # Stop if we hit our target count exactly
                if len(formatted_txs) >= count:
                    break
                    
                input_data = tx.get("input", "")
                
                formatted_tx = {
                    "hash": tx.get("hash"),
                    "blockNumber": str(current_block),
                    "timeStamp": str(block_timestamp), 
                    "from": tx.get("from"),
                    "to": tx.get("to") or "",
                    "value": str(int(tx.get("value", "0x0"), 16)),
                    "gasUsed": str(int(tx.get("gas", "0x0"), 16)),
                    "gasPrice": str(int(tx.get("gasPrice", "0x0"), 16)),
                    "methodId": input_data[:10] if input_data and input_data != "0x" else "",
                    "functionName": "",
                }
                formatted_txs.append(formatted_tx)
                
            current_block -= 1
            
        return formatted_txs


async def main():
    parser = argparse.ArgumentParser(description="Fetch recent Etherscan txs into Postgres")
    parser.add_argument("--api-key", type=str, required=True, help="Etherscan API Key")
    parser.add_argument("--count", type=int, default=30, help="Number of recent transactions to fetch")
    parser.add_argument(
        "--db-url",
        type=str,
        default="postgresql+asyncpg://postgres:postgres123@postgres:5432/chain_analysis",
        help="PostgreSQL Database URL",
    )
    args = parser.parse_args()

    # 1. Fetch recent data from Etherscan
    txs = await fetch_recent_transactions(args.api_key, args.count)
    if not txs:
        logger.info("No transactions found or failed to fetch.")
        return

    logger.info(f"Processing {len(txs)} retrieved transactions...")

    # 2. Setup Database Connection
    engine = create_async_engine(args.db_url, echo=False)
    async_session = async_sessionmaker(engine, expire_on_commit=False)

    # 3. Transform and Insert data
    inserted_count = 0
    async with async_session() as session:
        for tx in txs:
            to_address = tx.get("to")
            if to_address == "":
                to_address = None 
                
            tx_data = {
                "hash": tx["hash"],
                "chain_id": 1,
                "block_number": int(tx["blockNumber"]),
                "block_timestamp": datetime.fromtimestamp(int(tx["timeStamp"]), tz=timezone.utc),
                "from_address": tx["from"],
                "to_address": to_address,
                "value_wei": Decimal(tx["value"]),
                "gas_used": int(tx["gasUsed"]),
                "gas_price": Decimal(tx["gasPrice"]),
                "method_id": tx.get("methodId", "") or None,
                "function_name": tx.get("functionName", "") or None,
            }

            stmt = insert(RawTransaction).values(**tx_data)
            stmt = stmt.on_conflict_do_nothing(
                index_elements=['hash', 'chain_id']
            )

            await session.execute(stmt)
            inserted_count += 1
            
        await session.commit()
    
    await engine.dispose()
    logger.info(f"Successfully processed and stored {inserted_count} transactions!")


if __name__ == "__main__":
    asyncio.run(main())
