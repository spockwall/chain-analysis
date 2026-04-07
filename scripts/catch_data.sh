#!/usr/bin/env bash
# Usage: ./catch_data.sh <ethereum_address>
# Fetches all transactions for the given address from Etherscan,
# writes them to Redis Streams, then processes into Neo4j + PostgreSQL.
set -euo pipefail

ADDRESS="${1:-}"
if [[ -z "$ADDRESS" ]]; then
  echo "Usage: $0 <ethereum_address>"
  echo "Example: $0 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  exit 1
fi

# Always run docker compose from the repo root where docker-compose.yml lives
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[1/2] Ingesting $ADDRESS from Etherscan → Redis..."
docker compose --profile ingest run --rm ingest \
  --address "$ADDRESS" \
  --with-traces \
  --with-transfers

echo "[2/2] Processing Redis → Neo4j + PostgreSQL..."
docker compose --profile etl run --rm process --one-shot

echo "Done. Data for $ADDRESS is now in the database."
