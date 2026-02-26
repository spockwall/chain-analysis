# Neo4j Query Analysis

Covers every Cypher query in `backend/src/core/adapters/neo4j_adapter.py`.
Complexity uses: **E** = entity count, **T** = transaction count, **K** = average tx degree per entity, **G** = group member count, **N** = batch size, **D** = path depth.

---

## Schema — Indexes and Constraints

| Name | Type | Field | Used by |
|---|---|---|---|
| `entity_address` | UNIQUE constraint (B-tree) | `Entity.address` | All entity lookups |
| `entity_type` | B-tree | `Entity.entity_type` | Filter queries |
| `entity_risk` | B-tree | `Entity.risk_level` | Filter queries |
| `entity_type_risk` | B-tree composite | `Entity.(entity_type, risk_level)` | Combined filter queries |
| `entity_first_seen` | B-tree | `Entity.first_seen` | Temporal queries |
| `tx_hash` | UNIQUE constraint (B-tree) | `Transaction.hash` | All tx lookups |
| `tx_block` | B-tree | `Transaction.block_number` | Block range queries |
| `tx_ts` | B-tree | `Transaction.timestamp` | Temporal queries |
| `tx_value` | B-tree | `Transaction.value` | Value filter/sort |
| `tx_from` | B-tree | `Transaction.from_address` | Direct sender lookups |
| `tx_to` | B-tree | `Transaction.to_address` | Direct receiver lookups |
| `in_group_added_at` | B-tree on relationship | `IN_GROUP.added_at` | Temporal membership queries |

> **Migration note:** The old index `member_of_added_at` targeted `MEMBER_OF` relationships but the adapter
> exclusively uses `IN_GROUP`. It has been replaced by `in_group_added_at`. If upgrading from an old
> instance, drop the dead index manually: `DROP INDEX member_of_added_at IF EXISTS`

---

## Write Queries

### `upsert_nodes` — O(N log E)

```cypher
UNWIND $nodes AS node
MERGE (e:Entity {address: node.address})   -- point-lookup via entity_address unique index
SET e += node.properties
-- APOC variant: CALL apoc.create.addLabels(e, node.labels)
```

**Concept:** Streams a parameter list into Neo4j via `UNWIND`, then uses `MERGE` to
create-or-match each entity by its unique address. `SET e += ...` merges properties without
overwriting unmentioned fields. The APOC variant additionally assigns type sub-labels
(`:EOA`, `:Mixer`, etc.); the fallback silently skips labelling if APOC is unavailable.

**Complexity:** Each `MERGE` is one B-tree lookup — O(log E). For a batch of N nodes: **O(N log E)**.

---

### `upsert_transactions` — O(N log E + N log T)

```cypher
UNWIND $txs AS tx
MERGE (from:Entity {address: tx.from_address})   -- ensure sender entity exists
  ON CREATE SET from.risk_level = 'unknown'
MERGE (to:Entity {address: tx.to_address})       -- ensure receiver entity exists
  ON CREATE SET to.risk_level = 'unknown'
MERGE (t:Transaction {hash: tx.hash})            -- create or match tx node
SET t += tx.properties,
    t.from_address = tx.from_address,
    t.to_address   = tx.to_address
MERGE (from)-[:SENT]->(t)                        -- link sender → tx
MERGE (t)-[:RECEIVED]->(to)                      -- link tx → receiver
```

**Concept:** Entity MERGEs come first — this guarantees both endpoint Entity nodes exist
before the Transaction node and its relationships are created. `ON CREATE SET` only fires
for newly created entities, leaving existing entities untouched. Storing `from_address` and
`to_address` as properties on the Transaction node (in addition to the relationships)
allows fallback lookups if relationship traversal is not available.

**Complexity:** Two entity lookups + one tx lookup per row: **O(N · (log E + log T))**,
effectively **O(N log T)** since T ≥ E in a real dataset.

---

## Read Queries

### `get_transaction` — O(log T)

```cypher
MATCH (t:Transaction {hash: $hash})          -- tx_hash unique index point-lookup
OPTIONAL MATCH (from:Entity)-[:SENT]->(t)   -- at most one SENT edge
OPTIONAL MATCH (t)-[:RECEIVED]->(to:Entity) -- at most one RECEIVED edge
RETURN t, from.address, to.address
```

**Concept:** Direct hash lookup returns the transaction node in O(log T). The two
`OPTIONAL MATCH` clauses each follow a single relationship edge — they do not scan;
they resolve the connected entity in O(1). `OPTIONAL` means the query succeeds even
if relationships haven't been created yet (transaction stored without linked entities).

**Complexity:** **O(log T)** — effectively constant at scale.

---

### `get_node` — O(log E + G)

```cypher
MATCH (e:Entity {address: $address})             -- entity_address unique index
OPTIONAL MATCH (member:Entity)-[:IN_GROUP]->(e)  -- expand all incoming IN_GROUP edges
RETURN e, labels(e) AS labels, count(member) AS member_count
```

**Concept:** Point-lookup by unique address, then counts how many entities have an
`IN_GROUP` edge pointing to this node (i.e. how many members belong to this group).
The `count(member)` aggregate avoids returning all member nodes — only the count is
fetched, keeping the result payload small. Non-group entities return count = 0.

**Complexity:** **O(log E + G)** where G is the group's member count. G is typically small.

---

### `get_neighbors` — O(log E + K)

Three direction variants; all anchor on the indexed Entity node and traverse relationships —
no Transaction property scan occurs.

#### `out` — outgoing transactions
```cypher
MATCH (center:Entity {address: $address})-[:SENT]->(tx:Transaction)-[:RECEIVED]->(neighbor:Entity)
WITH tx, neighbor LIMIT $limit
RETURN collect(DISTINCT neighbor) AS neighbors, collect(DISTINCT tx) AS txs
```
Follows outgoing `SENT` edges from the center, then `RECEIVED` edges to destination entities.

#### `in` — incoming transactions
```cypher
MATCH (neighbor:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(center:Entity {address: $address})
WITH tx, neighbor LIMIT $limit
RETURN collect(DISTINCT neighbor) AS neighbors, collect(DISTINCT tx) AS txs
```
Traverses in reverse: finds all transactions whose `RECEIVED` edge terminates at center.

#### `both` — all transactions
```cypher
MATCH (center:Entity {address: $address})
OPTIONAL MATCH (center)-[:SENT]->(out_tx:Transaction)-[:RECEIVED]->(out_nb:Entity)
OPTIONAL MATCH (in_nb:Entity)-[:SENT]->(in_tx:Transaction)-[:RECEIVED]->(center)
WITH
    collect(DISTINCT out_nb) + collect(DISTINCT in_nb) AS neighbors,
    collect(DISTINCT out_tx) + collect(DISTINCT in_tx) AS txs
RETURN
    [x IN neighbors WHERE x IS NOT NULL] AS neighbors,
    [x IN txs WHERE x IS NOT NULL] AS txs
LIMIT $limit
```
Two independent `OPTIONAL MATCH` traversals from the same anchor; results are concatenated
then filtered for nulls (which arise when a direction has no transactions). `LIMIT` is applied
after aggregation to cap the returned collection size.

**Complexity (all directions):** **O(log E + K)** where K ≤ `limit`. The `LIMIT` clause
prevents unbounded expansion on high-degree hub nodes (exchanges, mixers).

---

### `add_group_member` — O(log E)

```cypher
MATCH (grp:Entity {address: $group})
MERGE (member:Entity {address: $member})
MERGE (member)-[:IN_GROUP {added_at: $now}]->(grp)
```

**Concept:** Looks up the group by address (must already exist — `MATCH` not `MERGE`),
then creates the member entity if absent, then creates the membership relationship if
absent. The `added_at` timestamp on the relationship enables temporal auditing.
Business logic (one-group-at-a-time enforcement) is handled in the route layer before
this query runs.

**Complexity:** Two B-tree lookups + one small relationship check: **O(log E)**.

---

### `remove_group_member` — O(log E)

```cypher
MATCH (member:Entity {address: $member})-[r:IN_GROUP]->(grp:Entity {address: $group})
DELETE r
```

**Concept:** Both endpoints are resolved via their unique address indexes; Neo4j
intersects the `IN_GROUP` relationships from each side to identify the specific edge,
then deletes only that relationship. The entity nodes themselves are untouched.

**Complexity:** **O(log E)** — two index lookups then one edge deletion.

---

### `get_group_members` — O(log E + G)

```cypher
MATCH (member:Entity)-[:IN_GROUP]->(grp:Entity {address: $group})
RETURN member, labels(member) AS labels
```

**Concept:** Index-anchors on the group node, then expands all incoming `IN_GROUP`
edges to collect every member entity. Returns full node data for each member so the
caller can display member properties without additional round-trips.

**Complexity:** **O(log E + G)** — unavoidably linear in G since all members must be returned.

---

### `get_group_parent` — O(log E)

```cypher
MATCH (member:Entity {address: $member})-[:IN_GROUP]->(grp:Entity)
RETURN grp, labels(grp) AS labels
```

**Concept:** Looks up the member by address, then follows its single outgoing `IN_GROUP`
edge to find the parent group. Because the business rule enforces membership in at most
one group, this traversal always terminates after one edge.

**Complexity:** **O(log E)** — index lookup + one edge follow.

---

### `find_paths` — O(K^D) worst case, bounded by LIMIT

```cypher
MATCH path = (s:Entity {address: $source})
  ((-[:SENT]->(:Transaction)-[:RECEIVED]->){1..max_depth})(t:Entity {address: $target})
RETURN path
LIMIT $limit
```

**Concept:** Uses Neo4j 5's quantified path pattern syntax to express a bounded BFS/DFS.
Each repetition of `(-[:SENT]->(:Transaction)-[:RECEIVED]->)` is one entity-to-entity hop
via an intermediate Transaction node. The planner explores paths of length 1 up to
`max_depth` hops, returning up to `limit` complete paths. Early termination fires as soon
as `limit` results are found, which in practice keeps this tractable.

**Complexity:** Worst case **O(K^D)** — exponential in depth, polynomial in K.
With default `max_depth=10` and high-degree hub nodes (e.g. exchange hot wallets with
millions of counterparties), this can fan out severely. The `LIMIT` clause is the primary
guard; consider lowering `max_depth` for production or adding degree-cutoff filtering.

---

## Complexity Summary

| Method | Complexity | Index anchor | Risk |
|---|---|---|---|
| `upsert_nodes` | O(N log E) | `entity_address` | Low |
| `upsert_transactions` | O(N log T) | `entity_address`, `tx_hash` | Low |
| `get_transaction` | O(log T) | `tx_hash` | None |
| `get_node` | O(log E + G) | `entity_address` | Low (G small) |
| `get_neighbors` out/in | O(log E + K) | `entity_address` | Low (LIMIT guards K) |
| `get_neighbors` both | O(log E + K) | `entity_address` | Low (LIMIT guards K) |
| `add_group_member` | O(log E) | `entity_address` | None |
| `remove_group_member` | O(log E) | `entity_address` | None |
| `get_group_members` | O(log E + G) | `entity_address` | Low (G small) |
| `get_group_parent` | O(log E) | `entity_address` | None |
| `find_paths` | O(K^D) worst | `entity_address` | **High** — depth + hub degree |

---

## Open Issues

1. **`find_paths` depth** — default `max_depth=10` is aggressive. Hub nodes (CEX hot
   wallets, mixers) can have degree in the millions; intersecting at depth 10 can time out.
   Recommended: lower default to 4–6 and expose `max_depth` as a user-tunable parameter
   with a hard server-side cap.

