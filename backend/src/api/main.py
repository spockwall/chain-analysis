"""
FastAPI application factory.

Run with: uvicorn src.api.main:app --reload
"""

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.deps import close_adapters, init_adapters
from api.routes import entities_router, health_router, labels_router
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

    # Register routers
    app.include_router(health_router)
    app.include_router(entities_router, prefix="/api")
    app.include_router(labels_router, prefix="/api")

    return app


# Create the app instance
app = create_app()
