"""API route modules."""

from .entities import router as entities_router
from .health import router as health_router
from .labels import router as labels_router

__all__ = ["entities_router", "health_router", "labels_router"]
