"""API route modules."""

from .auth import router as auth_router
from .entities import (
    router as entities_router,
    transactions_router,
    write_router as entities_write_router,
)
from .groups import router as groups_router
from .health import router as health_router
from .labels import router as labels_router
from .stats import router as stats_router

__all__ = [
    "auth_router",
    "entities_router",
    "entities_write_router",
    "groups_router",
    "health_router",
    "labels_router",
    "stats_router",
    "transactions_router",
]
