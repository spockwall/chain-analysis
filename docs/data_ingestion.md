# Data Ingestion Scripts

To pull live blockchain data directly into the PostgreSQL `raw_transactions` table (intentionally bypassing Neo4j for initial data staging), you can use the Etherscan ingestion scripts located in the `/scripts` directory.

Since the application runs inside Docker, the most reliable way to execute these scripts and connect gracefully to the database is to run them **inside the running backend container**.

## Prerequisites

1. Ensure your backend and PostgreSQL containers are running:
   ```bash
   docker compose up -d backend postgres
   ```
2. Get a free API Key from [Etherscan](https://etherscan.io/apis).

---

## Usage

### 1. Fetching recent network-wide transactions 

To fetch the most recent global transactions across the entire network, going backward from the latest block until the target count is resolved. This distributes data correctly into the 16 hash partitions in PostgreSQL.

```bash
docker exec -it chain-analysis-backend python /app/scripts/fetch_etherscan_recent.py \
  --api-key "YOUR_ETHERSCAN_KEY" \
  --count 5000
```
> **Note:** The script respects Etherscan's rate limits and will dynamically sleep and retry if you hit the limit (3 requests per second on a free tier).

### 2. Fetching transactions for a specific address

If you are investigating a specific entity (like a hacker or a mixer) and want all of their recent transactions:

```bash
docker exec -it chain-analysis-backend python /app/scripts/fetch_etherscan.py \
  --address "0x_TARGET_ADDRESS" \
  --api-key "YOUR_ETHERSCAN_KEY"
```

---

## Verifying the Data

Because the data is not immediately ported to the graph database (Neo4j), it will not show up in the web frontend Explorer.

To verify the raw data arrived safely in the Postgres partitions, run this SQL query directly in Docker:

```bash
# Check the total count of ingested transactions
docker exec -it chain-analysis-postgres psql -U postgres -d chain_analysis -c "SELECT COUNT(*) FROM raw_transactions;"

# View the 5 most recently inserted transactions 
docker exec -it chain-analysis-postgres psql -U postgres -d chain_analysis -c "SELECT hash, block_number, from_address, to_address, value_wei FROM raw_transactions ORDER BY block_timestamp DESC LIMIT 5;"
```
