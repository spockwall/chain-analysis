# Chain-Analysis Backend

FastAPI backend for the Chain-Analysis blockchain AML platform.

## Requirements

- Python 3.11+
- Docker (for infrastructure services)

## Quick Start

### 1. Start Infrastructure Services

```bash
cp compose/secrets.dev.env.example compose/secrets.dev.env
docker compose up -d neo4j postgres redis minio minio-init
```

### 2. Install Dependencies

```bash
cd backend
pip install -e ".[dev]"
```

### 3. Run Database Migrations

```bash
alembic upgrade head
```

### 4. Initialize Neo4j Schema

```bash
python ../scripts/init_neo4j.py
```

### 5. Start the API Server

```bash
uvicorn src.api.main:app --reload --port 8000
```

The same process also mounts the MCP endpoint at `http://localhost:8000/mcp`.

## Running with Docker

```bash
cp compose/secrets.dev.env.example compose/secrets.dev.env
docker compose up -d backend
```

The backend will be available at http://localhost:8000

## MCP Server

The backend includes an MCP server so agents can call Chain-Analysis tools directly.

### Streamable HTTP

- Endpoint: `http://localhost:8000/mcp`
- Mounted inside the existing FastAPI app
- Requires the existing API bearer token in the `Authorization: Bearer <token>` header
- Obtain a token from `/api/auth/login` or `/api/auth/register`

### Stdio

After installing the backend package:

```bash
chain-analysis-mcp
```

This exposes the same tool set over stdio for local MCP clients.
Stdio does not use the HTTP bearer token flow.

## Project Structure

```
backend/
├── alembic/              # Database migrations
├── src/
│   ├── api/              # FastAPI application
│   │   ├── main.py       # App factory & lifespan
│   │   ├── deps.py       # Dependency injection
│   │   ├── routes/       # API endpoints
│   │   └── models/       # Pydantic schemas
│   ├── core/             # Abstractions & config
│   │   ├── config.py     # Pydantic settings
│   │   ├── ports/        # Abstract interfaces (protocols)
│   │   └── adapters/     # Concrete implementations
│   ├── services/         # Business logic
│   ├── db/               # SQLAlchemy models
│   ├── etl/              # Dagster pipeline
│   ├── graph/            # Neo4j query builders
│   └── libs/             # Shared utilities (logger)
└── tests/                # Pytest tests
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Full health check with service status |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |
| GET | `/api/entities/{address}` | Get entity details |
| GET | `/api/entities/{address}/neighbors` | Get entity neighborhood |
| GET | `/api/entities/{source}/paths/{target}` | Find paths between entities |
| POST | `/api/labels/tasks` | Create labeling task |
| GET | `/api/labels/tasks` | List labeling tasks |
| POST | `/api/labels/annotations` | Submit annotation |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVIRONMENT` | `local` | Environment (local/aws/gcp) |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | `password123` | Neo4j password |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `chain_analysis` | PostgreSQL database |
| `POSTGRES_USER` | `postgres` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `postgres123` | PostgreSQL password |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `MINIO_ENDPOINT` | `localhost:9000` | MinIO endpoint |
| `MINIO_ACCESS_KEY` | `minioadmin` | MinIO access key |
| `MINIO_SECRET_KEY` | `minioadmin123` | MinIO secret key |
| `MINIO_BUCKET` | `chain-analysis` | MinIO bucket name |

## Testing

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src

# Run only unit tests (no infrastructure required)
pytest -m "not integration"

# Run integration tests (requires running services)
pytest -m integration
```

## Architecture

The backend uses a **Port/Adapter (Hexagonal)** architecture for service abstraction:

- **Ports** (`src/core/ports/`): Abstract interfaces (Python Protocols)
- **Adapters** (`src/core/adapters/`): Concrete implementations

This allows swapping infrastructure (e.g., Neo4j → Neptune, Redis → SQS) by changing configuration without modifying business logic.
