# Group Nodes in the Graph Explorer

## Overview

A **group node** is a special entity in the chain-analysis graph that aggregates multiple on-chain addresses (its *members*) under a single named node. Common uses include:

- Labelling all hot-wallet addresses belonging to a single CEX as one group.
- Aggregating related mixer contracts.
- Bundling known bridge contracts under one identity.

Groups are created and managed on the [Groups page](/groups) and appear in the [Explorer](/explorer) alongside regular entity nodes.

---

## Visual Appearance

Group nodes are intentionally distinct from regular entity nodes in the graph canvas:

| Property | Regular Entity Node | Group Node |
|---|---|---|
| **Size** | 18 px | 34 px (≈ 1.9× larger) |
| **Border** | None | Solid violet (`#7c3aed`) 2.5 px |
| **Glow / shadow** | None | Violet radial glow |
| **Label** | Name or short address | Name *and* `● N members` on a second line |
| **Label colour** | Muted slate | Dark violet (`#4c1d95`) |

These properties are defined in
[`frontend/src/components/graph/stylesheet.ts`](../frontend/src/components/graph/stylesheet.ts)
under the `node[nodeKind="group"]` selector.

---

## Clicking a Group Node

Single-clicking a group node opens the **right-hand detail panel** which shows:

### Header
- Section label reads **"Selected Group"** (instead of "Selected Entity" for normal nodes).
- Full name and address with copy button.

### Classification
- Standard risk-level and entity-type badges.
- A vivid **"Group · N members"** violet badge showing the aggregate member count.

### Group Members
- Scrollable list (up to the full member set) of every address in the group.
- Each row shows:
  - The member **name** (if labeled) in bold violet.
  - The truncated hex **address** in monospace.
  - An **entity-type chip** (e.g. `Contract`, `EOA`).
  - A **×** button to remove the member from the group.
- Clicking a member row navigates to that address in the explorer.

### Add Member
- A text input and **Add** button at the bottom of the member list allows adding a new address to the group directly from the explorer.

---

## Data Model

Group membership is stored in the PostgreSQL `users`/groups tables and managed through the REST API:

| Endpoint | Description |
|---|---|
| `GET /api/v1/groups/{address}/members` | Fetch all members of a group |
| `POST /api/v1/groups/{address}/members` | Add a member to a group |
| `DELETE /api/v1/groups/{address}/members/{child}` | Remove a member from a group |

The `member_count` field is returned on every `EntityResponse` node and is used by both the graph canvas (to decide if a node is a group and what label to render) and the `NodePanel` (to show the classification badge).

---

## Technical Notes

- **`nodeKind` data attribute** — set to `"group"` in `GraphCanvas.tsx` `toElements()` when `member_count > 0`; `"entity"` otherwise.
- **Label wrapping** — Cytoscape's `text-wrap: wrap` is enabled globally; group nodes use `\n` in their label string to force the member count onto a second line.
- **Member fetch** — `NodePanel` calls `fetchGroupMembers(address)` on every node selection. It is a no-op (empty response) for non-group nodes, so there is no meaningful performance cost.
