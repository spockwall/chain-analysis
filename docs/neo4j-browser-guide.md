# Neo4j Browser Guide

How to use the Neo4j Browser to explore and query the graph database for Chain Analysis.

---

## Connecting

1. Open **http://localhost:7474** in your browser
2. Connect with:
   - Connect URL: `bolt://localhost:7687`
   - Username: `neo4j`
   - Password: `password123`

> Credentials come from `.env` (`NEO4J_USER` / `NEO4J_PASSWORD`).

---

## Seeding Sample Data

Before querying, seed the graph with the AML sample dataset:

```bash
# From the repo root
cd /path/to/chain-analysis

# 1. Initialize schema (constraints + indexes)
python scripts/init_neo4j.py

# 2. Seed sample nodes and edges
python scripts/seed_neo4j.py
```

This creates **31 nodes** and **22 edges** across two AML patterns:
- A **peel chain**: suspect → Tornado Cash → 3 hops → Binance
- A **structuring / fan-out**: whale → 5 smurfs → Coinbase

---

## Quick-start Queries

Paste any of these into the Neo4j Browser query bar and press `Ctrl+Enter` (or click the play button).

### See everything (start here)

```cypher
MATCH (n:Entity)-[r]->(m:Entity)
RETURN n, r, m
LIMIT 100
```

### Count nodes and edges

```cypher
MATCH (n:Entity) RETURN count(n) AS nodes;
MATCH ()-[r:TRANSFER]->() RETURN count(r) AS edges;
```

### Nodes by entity type

```cypher
MATCH (n:Entity)
RETURN labels(n) AS types, count(n) AS count
ORDER BY count DESC
```

### High-risk nodes

```cypher
MATCH (n:Entity)
WHERE n.risk_level IN ['high', 'critical']
RETURN n
```

---

## Investigating the Peel Chain Pattern

The seeded peel chain starts at the suspect wallet and routes through Tornado Cash.

```cypher
// Full peel chain — 4 hops from suspect to exit
MATCH path = (start:Entity {address: '0xaaaa000000000000000000000000000000000001'})
             -[:TRANSFER*1..6]->
             (end:Entity)
RETURN path
LIMIT 20
```

```cypher
// Show the suspect's direct neighbors
MATCH (n:Entity {address: '0xaaaa000000000000000000000000000000000001'})-[r]-(m)
RETURN n, r, m
```

```cypher
// Who deposited into Tornado Cash 10 ETH?
MATCH (src:Entity)-[r:TRANSFER]->(mixer:Entity {address: '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf'})
RETURN src, r, mixer
```

---

## Investigating the Structuring Pattern

The whale splits funds into 5 smurfs that all deposit to Coinbase.

```cypher
// Fan-out from whale
MATCH (whale:Entity {address: '0xbbbb000000000000000000000000000000000001'})-[r:TRANSFER]->(smurf)
RETURN whale, r, smurf
```

```cypher
// Fan-in to Coinbase — who sent funds?
MATCH (src)-[r:TRANSFER]->(cex:Entity {address: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3'})
RETURN src, r, cex
```

```cypher
// Full structuring subgraph in one query
MATCH path = (whale:Entity {address: '0xbbbb000000000000000000000000000000000001'})
             -[:TRANSFER*1..2]->
             (end:Entity)
RETURN path
```

---

## AML Detection Queries

### Detect peel chains
Single-input, single-output chains longer than 3 hops:

```cypher
MATCH path = (start:Entity)-[:TRANSFER*3..10]->(end:Entity)
WHERE ALL(n IN nodes(path)[1..-1]
          WHERE size((n)-[:TRANSFER]->()) = 1
          AND   size((n)<-[:TRANSFER]-()) = 1)
RETURN path
LIMIT 10
```

### Detect structuring (fan-out)
One sender → 5+ receivers in close block range:

```cypher
MATCH (src:Entity)-[r:TRANSFER]->(dst:Entity)
WITH src, collect(dst) AS receivers, collect(r.block_number) AS blocks
WHERE size(receivers) >= 5
  AND (max(blocks) - min(blocks)) < 100
RETURN src.address AS source, src.name AS name,
       size(receivers) AS fan_out,
       min(blocks) AS first_block,
       max(blocks) AS last_block
ORDER BY fan_out DESC
```

### Find paths between two addresses

```cypher
MATCH path = shortestPath(
  (a:Entity {address: '0xaaaa000000000000000000000000000000000001'})
  -[:TRANSFER*..10]-
  (b:Entity {address: '0x28c6c06298d514db089934071355e5743bf21d60'})
)
RETURN path
```

### Addresses within 2 hops of a mixer

```cypher
MATCH (mixer:Mixer)<-[:TRANSFER*1..2]-(suspect:Entity)
WHERE NOT suspect:Mixer
RETURN DISTINCT suspect.address, suspect.name, suspect.risk_level
ORDER BY suspect.risk_level DESC
```

### High-value transfers (> 50 ETH)

```cypher
MATCH (a:Entity)-[r:TRANSFER]->(b:Entity)
WHERE toFloat(r.value) > 50000000000000000000
RETURN a.address AS from, b.address AS to,
       toFloat(r.value) / 1e18 AS eth,
       r.block_number AS block
ORDER BY eth DESC
LIMIT 20
```

---

## Useful Browser Tips

| Action | How |
|--------|-----|
| Run query | `Ctrl+Enter` |
| Switch to table view | Click the table icon (bottom-left of result) |
| Expand a node's neighbors | Double-click a node in the graph view |
| Pin a node | Click once, then drag |
| Style nodes by property | Click the paint-brush icon in the result panel |
| Save a query as a favorite | Click the star icon next to the query bar |

### Styling nodes by risk level

In the browser result panel, click the node you want to style, then use the style sidebar to color by `risk_level`. Recommended palette:

| Risk Level | Color |
|------------|-------|
| critical | `#ef4444` (red) |
| high | `#f97316` (orange) |
| medium | `#eab308` (yellow) |
| low | `#22c55e` (green) |
| unknown | `#94a3b8` (gray) |

---

## Resetting the Database

To wipe all data and start fresh:

```cypher
// Delete all nodes and relationships
MATCH (n) DETACH DELETE n
```

Then re-run the seed script:

```bash
python scripts/seed_neo4j.py
```
