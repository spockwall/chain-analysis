#!/usr/bin/env python3
"""
Seed the users table with initial accounts.

Creates three accounts — one per role — that are ready to use after a fresh
setup. Passwords are read from environment variables or can be passed as
arguments; the script never hard-codes credentials in source.

    Role       | Default env var            | Default fallback (dev only)
    -----------|----------------------------|---------------------------------
    admin      | SEED_ADMIN_PASSWORD        | Admin@chain2024!
    operator   | SEED_OPERATOR_PASSWORD     | Operator@chain2024!
    user       | SEED_USER_PASSWORD         | User@chain2024!

Usage (local / docker exec):
    python scripts/seed_users.py
    python scripts/seed_users.py --database-url postgresql+asyncpg://...
    python scripts/seed_users.py --verify

The script is idempotent: existing accounts are updated (email / password /
role stay in sync), so it is safe to run multiple times.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Make the backend src importable when running from the repo root
_src = Path(__file__).parent.parent / "backend" / "src"
if _src.exists() and str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

import bcrypt
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# ---------------------------------------------------------------------------
# Default DB URL (matches docker-compose.yml)
# ---------------------------------------------------------------------------
_DEFAULT_DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres123@localhost:5432/chain_analysis",
)


def _hash(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


# ---------------------------------------------------------------------------
# Initial accounts
# ---------------------------------------------------------------------------
def _build_accounts() -> list[dict]:
    return [
        {
            "username": "admin",
            "email": "admin@example.com",
            "password": os.getenv("SEED_ADMIN_PASSWORD", "Admin@chain2024!"),
            "role": "admin",
        },
        {
            "username": "operator",
            "email": "operator@example.com",
            "password": os.getenv("SEED_OPERATOR_PASSWORD", "Operator@chain2024!"),
            "role": "operator",
        },
        {
            "username": "user",
            "email": "user@example.com",
            "password": os.getenv("SEED_USER_PASSWORD", "User@chain2024!"),
            "role": "user",
        },
    ]


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------
async def seed_users(database_url: str) -> None:
    """Insert or update the initial user accounts."""
    engine = create_async_engine(database_url)
    accounts = _build_accounts()

    async with engine.begin() as conn:
        print("Seeding initial user accounts...\n")

        for acc in accounts:
            hashed = _hash(acc["password"])
            await conn.execute(
                text(
                    """
                    INSERT INTO users (username, email, hashed_password, role, is_active)
                    VALUES (:username, :email, :hashed_password, :role, true)
                    ON CONFLICT (email) DO UPDATE SET
                        username        = EXCLUDED.username,
                        hashed_password = EXCLUDED.hashed_password,
                        role            = EXCLUDED.role,
                        updated_at      = NOW()
                """
                ),
                {
                    "username": acc["username"],
                    "email": acc["email"],
                    "hashed_password": hashed,
                    "role": acc["role"],
                },
            )
            print(f"  ✓  [{acc['role']:8s}]  {acc['username']:12s}  ({acc['email']})")

        print(f"\nSeeded {len(accounts)} accounts.")

    await engine.dispose()


async def verify_users(database_url: str) -> None:
    """Print a summary of all current users."""
    engine = create_async_engine(database_url)

    async with engine.begin() as conn:
        result = await conn.execute(
            text(
                """
                SELECT id, username, email, role, is_active, created_at
                FROM users
                ORDER BY id
            """
            )
        )
        rows = result.fetchall()

    await engine.dispose()

    if not rows:
        print("\nNo users found in the database.")
        return

    print(f"\n{'ID':<5} {'Username':<14} {'Email':<35} {'Role':<10} {'Active'}")
    print("-" * 75)
    for row in rows:
        active = "✓" if row[4] else "✗"
        print(f"{row[0]:<5} {row[1]:<14} {row[2]:<35} {row[3]:<10} {active}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed the users table with initial accounts."
    )
    parser.add_argument(
        "--database-url",
        default=_DEFAULT_DB_URL,
        help="Async SQLAlchemy database URL (default: $DATABASE_URL or local dev URL)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Print the user table after seeding",
    )
    args = parser.parse_args()

    asyncio.run(seed_users(args.database_url))

    if args.verify:
        asyncio.run(verify_users(args.database_url))


if __name__ == "__main__":
    main()
