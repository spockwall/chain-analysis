"""
FastAPI application factory.

Run with: uvicorn src.api.main:app --reload
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.deps import close_adapters, init_adapters
from api.routes import (
    admin_router,
    auth_router,
    entities_router,
    entities_write_router,
    features_router,
    groups_router,
    health_router,
    labels_router,
    pipeline_router,
    stats_router,
    transactions_router,
)
from core.config import get_settings
from libs import logger


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

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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
    app.include_router(pipeline_router, prefix="/api")
    app.include_router(ingestion_router, prefix="/api")

    return app


# Create the app instance
app = create_app()
