import sys
import asyncio

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler

from httpx import AsyncClient


@pytest.mark.asyncio
async def test_ingest_rate_limit_memory_storage():
    """Minimal end-to-end test of rate limiting using in-memory storage.

    This test creates a tiny FastAPI app with SlowAPI middleware and a
    single endpoint decorated with a small limit. We avoid the project
    app lifecycle and adapters to keep the test hermetic.
    """
    # Use memory storage to avoid requiring a running Redis instance
    limiter = Limiter(key_func=lambda request: request.client.host, storage_uri="memory://")

    app = FastAPI()
    app.state.limiter = limiter
    app.add_middleware(SlowAPIMiddleware)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.post("/test-ingest")
    @limiter.limit("2/minute")
    async def _test_ingest(request: Request):
        return JSONResponse({"ok": True}, status_code=202)

    async with AsyncClient(app=app, base_url="http://test") as client:
        r1 = await client.post("/test-ingest")
        assert r1.status_code == 202

        r2 = await client.post("/test-ingest")
        assert r2.status_code == 202

        # Third request should be rate-limited
        r3 = await client.post("/test-ingest")
        assert r3.status_code == 429


@pytest.mark.asyncio
async def test_labels_rate_limit_memory_storage():
    """Same as above but for a different endpoint and limit."""
    limiter = Limiter(key_func=lambda request: request.client.host, storage_uri="memory://")

    app = FastAPI()
    app.state.limiter = limiter
    app.add_middleware(SlowAPIMiddleware)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.post("/test-labels")
    @limiter.limit("1/minute")
    async def _test_labels(request: Request):
        return JSONResponse({"ok": True}, status_code=201)

    async with AsyncClient(app=app, base_url="http://test") as client:
        r1 = await client.post("/test-labels")
        assert r1.status_code == 201
        r2 = await client.post("/test-labels")
        assert r2.status_code == 429
