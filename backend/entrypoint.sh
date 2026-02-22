#!/bin/sh
# Backend container entrypoint.
# Runs one-time init scripts then starts the API server.
# All scripts are idempotent (MERGE / ON CONFLICT DO UPDATE), so re-running
# on container restart is safe.

set -e

_DB_URL="postgresql+asyncpg://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres123}@${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-chain_analysis}"

# ── 1. PostgreSQL schema migrations ──────────────────────────────────────────
echo "[entrypoint] Running Alembic migrations..."
alembic upgrade head

# ── 2. Seed PostgreSQL known_labels table ────────────────────────────────────
echo "[entrypoint] Seeding known labels..."
python /app/scripts/seed_known_labels.py --database-url "${_DB_URL}"

# ── 3. Seed initial user accounts (admin / operator / user) ──────────────────
echo "[entrypoint] Seeding initial user accounts..."
python /app/scripts/seed_users.py --database-url "${_DB_URL}"

# ── 4. Init Neo4j schema (constraints + indexes) ─────────────────────────────
echo "[entrypoint] Initialising Neo4j schema..."
python /app/scripts/init_neo4j.py \
  --uri      "${NEO4J_URI:-bolt://neo4j:7687}" \
  --user     "${NEO4J_USER:-neo4j}" \
  --password "${NEO4J_PASSWORD:-password123}"

# ── 5. Seed Neo4j sample data ─────────────────────────────────────────────────
echo "[entrypoint] Seeding Neo4j sample data..."
python /app/scripts/seed_neo4j.py \
  --uri      "${NEO4J_URI:-bolt://neo4j:7687}" \
  --user     "${NEO4J_USER:-neo4j}" \
  --password "${NEO4J_PASSWORD:-password123}"

# ── 6. Start the API server ───────────────────────────────────────────────────
echo "[entrypoint] Starting API server..."
exec uvicorn src.api.main:app --host 0.0.0.0 --port 8000
