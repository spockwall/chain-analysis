# Graph Database Entity Definitions

> **Source:** `backend/src/core/ports/graph_db.py`

This document describes the core data types used to represent graph entities and results in the chain analysis system. These are domain-layer dataclasses shared between the graph database port and its adapters (e.g., Neo4j).

---

## Node

Represents a graph **entity** — typically an Ethereum address (EOA, contract, group, etc.).

```python
@dataclass
class Node:
    address: str
    labels: list[str] = field(default_factory=list)
    properties: dict[str, Any] = field(default_factory=dict)
```

| Field | Type | Description |
|---|---|---|
| `address` | `str` | Ethereum address (0x-prefixed) — the unique identifier |
| `labels` | `list[str]` | Neo4j node labels (e.g., `["Entity", "EOA"]`) |
| `properties` | `dict[str, Any]` | Arbitrary metadata (risk level, name, tx count, etc.) |

---

## Transaction

Represents a blockchain transaction as a **first-class node** in the graph, rather than a bare edge.

```python
@dataclass
class Transaction:
    hash: str
    from_address: str
    to_address: str
    properties: dict[str, Any] = field(default_factory=dict)
```

| Field | Type | Description |
|---|---|---|
| `hash` | `str` | Transaction hash — the unique identifier |
| `from_address` | `str` | Sender entity address |
| `to_address` | `str` | Receiver entity address |
| `properties` | `dict[str, Any]` | Metadata (value in wei, gas used, block number, timestamp, etc.) |

**Graph pattern:**
```
(from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)
```

---

## Path

Represents a **path** between two nodes, returned by path-finding queries.

```python
@dataclass
class Path:
    nodes: list[Node]
    transactions: list[Transaction] = field(default_factory=list)
    total_value: str | None = None
```

| Field | Type | Description |
|---|---|---|
| `nodes` | `list[Node]` | Ordered list of entity nodes along the path |
| `transactions` | `list[Transaction]` | Transaction nodes along the path |
| `total_value` | `str \| None` | Aggregate value transferred in wei (string to avoid precision loss) |

---

## Subgraph

Represents the result of a **neighborhood exploration** around a center node.

```python
@dataclass
class Subgraph:
    nodes: list[Node]
    center_address: str | None = None
    transactions: list[Transaction] = field(default_factory=list)
```

| Field | Type | Description |
|---|---|---|
| `nodes` | `list[Node]` | All entity nodes within the explored neighborhood |
| `center_address` | `str \| None` | The address the exploration started from |
| `transactions` | `list[Transaction]` | Transaction nodes in the subgraph |

---

## GraphDatabase *(Protocol)*

The abstract interface that all graph database adapters must implement. Defined with `@runtime_checkable` so implementations can be verified at runtime via `isinstance()`.

**Current implementations:** `Neo4jAdapter`
**Planned:** `NeptuneAdapter`

### Methods

| Method | Returns | Description |
|---|---|---|
| `connect()` | `None` | Establish DB connection |
| `close()` | `None` | Close DB connection |
| `execute_query(query, params)` | `list[dict]` | Run a raw Cypher/Gremlin query |
| `upsert_nodes(nodes)` | `int` | Insert or update nodes (MERGE semantics) |
| `upsert_transactions(txs)` | `int` | Insert or update Transaction nodes |
| `get_node(address)` | `Node \| None` | Fetch a single node by address |
| `get_transaction(hash)` | `Transaction \| None` | Fetch a single transaction by hash |
| `get_neighbors(address, depth, direction, limit)` | `Subgraph` | Explore the neighborhood of a node |
| `find_paths(source, target, max_depth, limit)` | `list[Path]` | Find paths between two addresses |
| `add_group_member(group_address, member_address)` | `None` | Add a member to a group entity |
| `remove_group_member(group_address, member_address)` | `None` | Remove a member from a group entity |
| `get_group_members(group_address)` | `list[Node]` | List all members of a group |
| `get_group_parent(member_address)` | `Node \| None` | Get the group a member belongs to |
| `supports_gds()` | `bool` | Check if Graph Data Science algorithms are available |
| `run_algorithm(algorithm, params)` | `dict \| None` | Run a GDS algorithm (e.g., PageRank, Louvain) |

---

## Relationship to API Models

The types above are **domain/port layer** objects. They are converted to API response models (defined in `backend/src/api/models/entity.py`) at the boundary:

| Graph Layer | API Layer |
|---|---|
| `Node` | `EntityResponse` |
| `Transaction` | `TransactionResponse` |
| `Subgraph` | `NeighborsResponse` |
| `Path` | `PathResponse` |
