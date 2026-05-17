---
name: conventions
description: Code style rules per stack — Python backend (async Neo4j driver, Pydantic schemas, SQLAlchemy async + asyncpg, Alembic asyncio.run pattern, 204 No Content handling, JWT HTTPBearer); TypeScript frontend (useToastContext for user feedback, Cytoscape lazy-load, entity/tx node colors, SENT/RECEIVED edge separation, React Router v6 pages, Tailwind-only styling, API client noContent flag); Tailwind patterns (local class const strings like btnPrimary/inputCls, custom keyframes in tailwind.config.js, RISK_BADGE_CLASSES lookup); Neo4j Cypher (always parameterize, LIMIT clauses, quantified path patterns for multi-hop). Invoke when writing code in any of these stacks, refactoring, or reviewing a PR for style.
---

## Python (Backend)
- Use async Neo4j driver with session-per-request pattern
- Pydantic models for all API request/response schemas
- SQLAlchemy async + asyncpg for PostgreSQL (no psycopg2)
- Alembic env.py uses `asyncio.run(run_async_migrations())` pattern
- 204 No Content responses: use raw `fetch` or `noContent=True` flag — never call `.json()` on empty body
- Auth: JWT in `Authorization: Bearer <token>` header; `HTTPBearer` dependency in `routes/auth.py`

## TypeScript (Frontend)
- All user feedback via `useToastContext()` — never inline error divs
- Cytoscape.js: lazy-load 1-2 hop neighborhoods, never load entire graph
- Entity nodes: colored circles by `entity_type`; Transaction nodes: diamonds (`#3b82f6`)
- Edges: `SENT` (entity→tx) and `RECEIVED` (tx→entity) rendered separately
- Pages are full-page routed via React Router v6, switched via `<NavLink>` tabs in `Nav.tsx`
- All styling uses Tailwind CSS utility classes — `index.css` contains only reset, `:root` tokens, `.grid-bg`, `.app-shell`, scrollbar
- API client `request()` helper attaches JWT from `localStorage`; accepts `noContent = true` for 204 endpoints

## Tailwind Patterns
- Local const strings for repeated class sets: `btnPrimary`, `btnPrimarySm`, `btnGhost`, `btnDangerSm`, `inputCls`, `sectionLabel`
- Custom animations defined in `tailwind.config.js` `theme.extend.keyframes`: `toast-slide-in`, `slide-in`
- Risk badge colors use explicit lookup objects (`RISK_BADGE_CLASSES`) rather than CSS custom properties

## Neo4j Queries
- Always parameterize queries (prevent injection)
- Use `LIMIT` clauses to prevent runaway queries
- Multi-hop traversals use quantified path patterns: `((-[:SENT]->(:Transaction)-[:RECEIVED]->){1..N})`
