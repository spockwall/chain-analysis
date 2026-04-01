"""FastAPI application package for Chain-Analysis."""


def create_app():
    """Lazily import the application factory to avoid package import cycles."""
    from .main import create_app as _create_app

    return _create_app()


__all__ = ["create_app"]
