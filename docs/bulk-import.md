# Bulk Transaction Import

The **ETL → Import Transactions** section lets you load dozens or hundreds of transactions at once from a single file, instead of entering them one-by-one.

---

## Supported Formats

### JSON

Either **an array of objects**:
```json
[
  {
    "hash": "0xabc…",
    "from_address": "0x28c…",
    "to_address": "0xd8d…",
    "value": "1.5",
    "block_number": 18000000
  }
]
```
or a **single object** (for a one-row import).

Field names are accepted in either `snake_case` or `camelCase` (e.g. `from_address` or `fromAddress`).

### CSV

First row must be a header; fields can be in any order:

```csv
hash,from_address,to_address,value,block_number,gas_used,gas_price
0xabc…,0x28c…,0xd8d…,1.5,18000000,21000,20000000000
```

---

## Required Fields

| Field | Description |
|---|---|
| `hash` | Transaction hash — `0x` followed by 64 hex characters |
| `from_address` | Sender address — `0x` followed by 40 hex characters |
| `to_address` | Recipient address — `0x` followed by 40 hex characters |

## Optional Fields

| Field | Description |
|---|---|
| `value` | Amount transferred. If ≤ 1e15 it is treated as **ETH** and converted to wei. If > 1e15 it is treated as **wei** directly. |
| `block_number` | Block number (positive integer) |
| `timestamp` | ISO 8601 timestamp string |
| `gas_used` | Gas used (integer) |
| `gas_price` | Gas price in wei (string) |

---

## How to Use

1. Navigate to **ETL → Import Transactions**.
2. **Drag and drop** a `.json` or `.csv` file onto the drop zone, or click **Choose File**.
3. A **preview table** appears with every row and its validation status:
   - ✓ **valid** rows shown normally
   - ✗ **Invalid** rows shown in red (hover the badge to see the error)
4. Click **Import N valid rows** to start the upload. Invalid rows are skipped automatically.
5. A **progress bar** shows `X / N` completed. Click **Cancel** to stop after the current row.
6. When done, a **summary** shows how many succeeded and how many failed. Click **Import another file** to reset.

---

## Sample Files

Ready-to-use example files are in [`docs/examples/`](examples/):

- [`sample_transactions.json`](examples/sample_transactions.json) — 3-row JSON array
- [`sample_transactions.csv`](examples/sample_transactions.csv) — 3-row CSV with header

---

## Notes

- The import calls the existing `PUT /api/transactions/{hash}` endpoint for each row **sequentially**. There is no dedicated bulk endpoint.
- Rows are submitted in file order. If the same hash appears more than once, the last occurrence wins (the API is idempotent).
- The Graph Statistics panel refreshes automatically when import finishes.
