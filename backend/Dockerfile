# Multi-stage build for Chain-Analysis Backend

# =============================================================================
# Stage 1: Build dependencies
# =============================================================================
FROM python:3.13-slim AS builder

WORKDIR /app

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files and source for editable install
COPY backend/pyproject.toml backend/README.md ./
COPY backend/src ./src

# Install dependencies into /app/.venv
RUN uv venv .venv && \
    uv pip install --python .venv/bin/python -e . --no-cache

# =============================================================================
# Stage 2: Production image
# =============================================================================
FROM python:3.13-slim AS production

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy the virtual environment from builder
COPY --from=builder /app/.venv .venv

# Copy application source
COPY backend/src ./src
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./

# Copy init scripts (from repo root scripts/)
COPY scripts /app/scripts

# Copy and wire up entrypoint
COPY backend/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Make sure the venv Python is on PATH
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app/src"
ENV PYTHONUNBUFFERED=1

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -f http://localhost:8000/health/live || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
