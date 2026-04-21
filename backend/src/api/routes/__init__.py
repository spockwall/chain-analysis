"""API route modules."""

from .admin import router as admin_router
from .auth import router as auth_router
from .entities import (
    router as entities_router,
    transactions_router,
    write_router as entities_write_router,
)
from .features import router as features_router
from .groups import router as groups_router
from .health import router as health_router
from .ingestion import router as ingestion_router
from .labels import router as labels_router
from .pipeline import router as pipeline_router
from .stats import router as stats_router

__all__ = [
    "admin_router",
    "auth_router",
    "entities_router",
    "entities_write_router",
    "features_router",
    "groups_router",
    "health_router",
    "ingestion_router",
    "labels_router",
    "pipeline_router",
    "stats_router",
    "transactions_router",
]
