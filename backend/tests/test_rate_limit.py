import sys
import asyncio

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler

from httpx import AsyncClient, ASGITransport

from src.core.config import Settings
from src.libs import rate_limiter
from src.services.auth import create_access_token


def _request(headers: dict[str, str] | None = None) -> Request:
    raw_headers = [
        (key.lower().encode(), value.encode())
        for key, value in (headers or {}).items()
    ]
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/test",
            "headers": raw_headers,
            "client": ("203.0.113.10", 12345),
        }
    )


def test_rate_limit_key_uses_cookie_jwt(monkeypatch):
    token = create_access_token(
        data={"sub": "42"},
        secret_key="current-secret",
        algorithm="HS256",
    )
    monkeypatch.setattr(
        rate_limiter,
        "get_settings",
        lambda: Settings(jwt_secret_key="current-secret"),
    )

    request = _request({"Cookie": f"access_token={token}"})

    assert rate_limiter._key_func(request) == "user:42"


def test_rate_limit_key_accepts_rotated_previous_secret(monkeypatch):
    token = create_access_token(
        data={"sub": "84"},
        secret_key="previous-secret",
        algorithm="HS256",
    )
    monkeypatch.setattr(
        rate_limiter,
        "get_settings",
        lambda: Settings(
            jwt_secret_key="current-secret",
            jwt_previous_secret_key="previous-secret",
        ),
    )

    request = _request({"Authorization": f"Bearer {token}"})

    assert rate_limiter._key_func(request) == "user:84"


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

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
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

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r1 = await client.post("/test-labels")
        assert r1.status_code == 201
        r2 = await client.post("/test-labels")
        assert r2.status_code == 429
