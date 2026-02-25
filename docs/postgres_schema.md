# PostgreSQL Table Schema

> **Source:** `backend/src/db/models.py`
> **Migrations:** `backend/alembic/versions/`

This document describes all PostgreSQL tables in the chain analysis system, their columns, and their purpose.

---

## Table Overview

| Table | Migration | Purpose |
|---|---|---|
| `users` | 002 | Application users with auth credentials and role-based access |
| `label_tasks` | 001 | Labeling tasks assigned to analysts |
| `annotations` | 001 | Label annotations submitted by analysts |
| `known_labels` | 001 | Reference data for known entities (exchanges, mixers, etc.) |
| `ingestion_runs` | 001 | ETL pipeline run records |
| `entity_features` | 003 | Computed on-chain behavioural features per entity address |

---

## `users`

Application users with authentication credentials and role-based access control.

| Column | Type | Description |
|---|---|---|
| `id` | `INTEGER PK` | Auto-increment primary key |
| `username` | `VARCHAR(100)` | Unique username |
| `email` | `VARCHAR(255)` | Unique email address |
| `hashed_password` | `VARCHAR(255)` | Bcrypt-hashed password |
| `role` | `VARCHAR(50)` | Role: `admin`, `operator`, or `user` |
| `is_active` | `BOOLEAN` | Whether the account is active |
| `created_at` | `TIMESTAMPTZ` | Account creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

**Roles:**
- `admin` — full control; manage users, operators, all data
- `operator` — data provider / analyst; can ingest and annotate
- `user` — read-only viewer
---

## `label_tasks`

A labeling task representing one entity address that needs to be reviewed and annotated.

| Column | Type | Description |
|---|---|---|
| `id` | `INTEGER PK` | Auto-increment primary key |
| `entity_address` | `VARCHAR(42)` | Ethereum address to label |
| `status` | `taskstatus` | `pending`, `in_progress`, `completed`, `skipped` |
| `priority` | `INTEGER` | Higher value = more urgent |
| `title` | `VARCHAR(255)` | Optional task title |
| `description` | `TEXT` | Optional task description |
| `context` | `JSON` | Subgraph context data for the labeler |
| `assignee_id` | `INTEGER FK → users.id` | Assigned analyst (nullable) |
| `assigned_at` | `TIMESTAMPTZ` | When the task was assigned |
| `created_at` | `TIMESTAMPTZ` | Task creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |
| `completed_at` | `TIMESTAMPTZ` | When the task was completed |

**Indexes:** `(status, priority)`

---

## `annotations`

A label annotation submitted by an analyst for a specific entity.

| Column | Type | Description |
|---|---|---|
| `id` | `INTEGER PK` | Auto-increment primary key |
| `task_id` | `INTEGER FK → label_tasks.id` | The task this annotation belongs to |
| `user_id` | `INTEGER FK → users.id` | The analyst who submitted this annotation (nullable) |
| `entity_address` | `VARCHAR(42)` | The annotated Ethereum address |
| `entity_type` | `entitytype` | Classified type (EOA, Contract, Mixer, etc.) |
| `risk_level` | `risklevel` | `unknown`, `low`, `medium`, `high`, `critical` |
| `labels` | `JSON` | Additional string tags |
| `notes` | `TEXT` | Analyst's free-text notes |
| `evidence` | `JSON` | Supporting evidence data |
| `confidence` | `FLOAT` | Confidence score (0.0 – 1.0) |
| `created_at` | `TIMESTAMPTZ` | Submission time |

**Indexes:** `(entity_address, user_id)`

---

## `known_labels`

Reference data for well-known entities pre-populated from public sources (e.g., Etherscan, Dune labels).

| Column | Type | Description |
|---|---|---|
| `id` | `INTEGER PK` | Auto-increment primary key |
| `address` | `VARCHAR(42)` | Ethereum address |
| `chain_id` | `INTEGER` | Chain ID (default: 1 = Ethereum mainnet) |
| `name` | `VARCHAR(255)` | Human-readable name (e.g., "Uniswap V3") |
| `entity_type` | `entitytype` | Entity type classification |
| `category` | `VARCHAR(100)` | Category (e.g., `exchange`, `defi`, `mixer`) |
| `subcategory` | `VARCHAR(100)` | Subcategory |
| `risk_level` | `risklevel` | Risk level |
| `source` | `VARCHAR(100)` | Data source (e.g., `etherscan`) |
| `source_url` | `VARCHAR(500)` | Source URL |
| `verified` | `BOOLEAN` | Whether the label has been verified |
| `metadata` | `JSON` | Additional metadata |
| `created_at` | `TIMESTAMPTZ` | Creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

**Unique constraint:** `(address, chain_id)`
**Indexes:** `(category)`

---

## `ingestion_runs`

Tracks ETL pipeline execution for monitoring and auditability.

| Column | Type | Description |
|---|---|---|
| `id` | `INTEGER PK` | Auto-increment primary key |
| `run_id` | `VARCHAR(36)` | UUID for the run |
| `chain_id` | `INTEGER` | Chain ID |
| `start_block` | `BIGINT` | Start block of the ingested range |
| `end_block` | `BIGINT` | End block of the ingested range |
| `data_source` | `VARCHAR(50)` | Data provider (e.g., `allium`) |
| `status` | `ingestionstatus` | `running`, `completed`, `failed` |
| `error_message` | `TEXT` | Error detail if failed |
| `transactions_processed` | `INTEGER` | Count of transactions processed |
| `traces_processed` | `INTEGER` | Count of traces processed |
| `nodes_created` | `INTEGER` | Count of Neo4j nodes upserted |
| `edges_created` | `INTEGER` | Count of Neo4j transaction relationships upserted |
| `started_at` | `TIMESTAMPTZ` | Run start time |
| `completed_at` | `TIMESTAMPTZ` | Run completion time |
| `dagster_run_id` | `VARCHAR(36)` | Corresponding Dagster run UUID |

**Indexes:** `(status)`, `(chain_id, start_block, end_block)`

---

## `entity_features`

Computed on-chain behavioural features for each entity address. Populated by the `computed_features` Dagster ETL asset and persisted here for structured querying, ML feature engineering, and risk dashboards.

> Previously, these values were only written to Neo4j node properties and not persisted in PostgreSQL. Added in migration 003.

| Column | Type | Group | Description |
|---|---|---|---|
| `address` | `VARCHAR(42) PK` | — | Ethereum address (primary key) |
| `chain_id` | `INTEGER` | — | Chain ID (default: 1) |
| `first_seen_at` | `TIMESTAMPTZ` | Timestamps | First on-chain appearance |
| `last_seen_at` | `TIMESTAMPTZ` | Timestamps | Most recent on-chain activity |
| `activity_interval_avg_sec` | `FLOAT` | Timestamps | Average interval between recent transactions (seconds) |
| `active_hour_distribution` | `JSON` | Timestamps | 24-element float array — activity ratio per UTC hour |
| `balance_avg_wei` | `NUMERIC(78,0)` | Balance | Average wallet balance in wei |
| `balance_max_wei` | `NUMERIC(78,0)` | Balance | Maximum observed wallet balance in wei |
| `has_deployed_contract` | `BOOLEAN` | Behaviour Flags | Whether this address has ever deployed a contract |
| `is_labeled` | `BOOLEAN` | Behaviour Flags | Whether this address is matched in `known_labels` |
| `out_degree` | `INTEGER` | Graph Topology | Number of outgoing transactions sent |
| `in_degree` | `INTEGER` | Graph Topology | Number of incoming transactions received |
| `unique_interacted_entities` | `INTEGER` | Graph Topology | Unique addresses interacted with (in + out union) |
| `same_type_transfer_count` | `INTEGER` | Risk Indicators | Transfers sent to addresses of the same entity type |
| `same_amount_transfer_count` | `INTEGER` | Risk Indicators | Transfers with identical outgoing amount (structuring pattern) |
| `volume_in_wei` | `NUMERIC(78,0)` | Volume | Total incoming value in wei |
| `volume_out_wei` | `NUMERIC(78,0)` | Volume | Total outgoing value in wei |
| `computed_at` | `TIMESTAMPTZ` | System | Timestamp of the last ETL computation |
| `updated_at` | `TIMESTAMPTZ` | System | Last row update time |

**Indexes:** `(chain_id, last_seen_at)`, `(same_amount_transfer_count, out_degree)`

---

## PostgreSQL Enums

| Enum | Values |
|---|---|
| `taskstatus` | `pending`, `in_progress`, `completed`, `skipped` |
| `risklevel` | `unknown`, `low`, `medium`, `high`, `critical` |
| `entitytype` | `EOA`, `Contract`, `Mixer`, `LendingPool`, `Bridge`, `DEX`, `CEXHotWallet`, `Application`, `Unknown` |
| `ingestionstatus` | `running`, `completed`, `failed` |

---

## Relationship to Graph Layer

PostgreSQL is responsible for **labeling workflow and metadata**. On-chain structure lives in Neo4j.

| PostgreSQL | Neo4j |
|---|---|
| `entity_features` | `Entity` node properties |
| `known_labels` | `Entity.labels`, `Entity.properties.risk_level` |
| `annotations` | Written back to `Entity` node on task completion |
| `ingestion_runs` | Tracks runs that produced Neo4j nodes/transactions |
