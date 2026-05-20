"""
FastAPI application factory.

Run with: uvicorn src.api.main:app --reload
"""

import secrets
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from agent_mcp.server import (
    chain_analysis_mcp_http_app as _chain_analysis_mcp_http_app,
    create_chain_analysis_mcp_http_app,
)
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from jose import JWTError
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler

from api.deps import close_adapters, init_adapters
from api.routes import (
    admin_router,
    auth_router,
    detections_router,
    entities_router,
    entities_write_router,
    features_router,
    groups_router,
    health_router,
    labels_router,
    pipeline_router,
    stats_router,
    transactions_router,
    ingestion_router,
)
from api.routes.auth import (
    ACCESS_TOKEN_COOKIE,
    CSRF_TOKEN_COOKIE,
    CSRF_TOKEN_HEADER,
    SAFE_METHODS,
)
from core.config import get_settings
from libs import logger
from libs.rate_limiter import limiter
from services.auth import decode_access_token


chain_analysis_mcp_http_app = _chain_analysis_mcp_http_app


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler for startup/shutdown."""
    settings = get_settings()

    # Startup
    logger.info("starting_application", environment=settings.environment)

    try:
        await init_adapters(settings)
        logger.info("adapters_initialized")
    except Exception as e:
        logger.error("adapter_initialization_failed", error=str(e))
        raise

    async with app.state.mcp_session_manager.run():
        logger.info("mcp_session_manager_started")
        yield

    # Shutdown
    logger.info("shutting_down_application")
    await close_adapters()
    logger.info("adapters_closed")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="Chain-Analysis API",
        description="Blockchain transaction analysis platform for AML investigation",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
    )

    # Attach limiter to app state and register middleware / handler
    app.state.limiter = limiter
    app.add_middleware(SlowAPIMiddleware)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def csrf_cookie_middleware(request: Request, call_next):
        if (
            request.method.upper() not in SAFE_METHODS
            and request.url.path
            not in {"/api/auth/login", "/api/auth/register", "/api/auth/logout"}
        ):
            token = request.cookies.get(ACCESS_TOKEN_COOKIE)
            if token:
                try:
                    payload = decode_access_token(
                        token,
                        settings.jwt_validation_secret_keys,
                        settings.jwt_algorithm,
                    )
                except JWTError:
                    payload = None

                expected = payload.get("csrf") if payload else None
                header_token = request.headers.get(CSRF_TOKEN_HEADER)
                cookie_token = request.cookies.get(CSRF_TOKEN_COOKIE)
                if (
                    not isinstance(expected, str)
                    or not header_token
                    or not cookie_token
                    or not secrets.compare_digest(header_token, cookie_token)
                    or not secrets.compare_digest(header_token, expected)
                ):
                    return JSONResponse(
                        {"detail": "CSRF token missing or invalid"},
                        status_code=status.HTTP_403_FORBIDDEN,
                    )

        return await call_next(request)

    # Register routers — write_router must come before read router so Starlette
    # matches PUT/PATCH/DELETE before the GET-only /{address} route.
    app.include_router(health_router)
    app.include_router(auth_router, prefix="/api")
    app.include_router(admin_router, prefix="/api")
    app.include_router(entities_write_router, prefix="/api")
    app.include_router(entities_router, prefix="/api")
    app.include_router(features_router, prefix="/api")
    app.include_router(transactions_router, prefix="/api")
    app.include_router(labels_router, prefix="/api")
    app.include_router(pipeline_router, prefix="/api")
    app.include_router(stats_router, prefix="/api")
    app.include_router(groups_router, prefix="/api")
    app.include_router(ingestion_router, prefix="/api")
    app.include_router(detections_router, prefix="/api")

    mcp_http_app, mcp_session_manager = create_chain_analysis_mcp_http_app()
    app.state.mcp_session_manager = mcp_session_manager
    app.mount("/mcp", mcp_http_app)

    return app


# Create the app instance
app = create_app()
