# Multi-stage build for Chain-Analysis Backend

# =============================================================================
# Stage 1: Build dependencies
# =============================================================================
FROM python:3.13-slim AS builder

WORKDIR /app

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files
COPY pyproject.toml ./

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
COPY src ./src
COPY alembic ./alembic
COPY alembic.ini ./

# Make sure the venv Python is on PATH
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app"
ENV PYTHONUNBUFFERED=1

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
