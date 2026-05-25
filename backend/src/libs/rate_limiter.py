"""Rate limiter initialization using slowapi + Redis storage.

Keying strategy: if a valid JWT Bearer token is present, use `user:{sub}`
otherwise fall back to remote IP address.
"""
from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from core.config import get_settings
from services.auth import decode_access_token


def _key_func(request: Request) -> str:
    """Return a key for rate limiting based on user id (sub) or IP.

    This function is intentionally defensive: any failure to decode the JWT
    falls back to IP-based limiting.
    """
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth.split(" ", 1)[1]
        try:
            settings = get_settings()
            payload = decode_access_token(token, settings.jwt_secret_key, settings.jwt_algorithm)
            user_id = payload.get("sub")
            if user_id:
                return f"user:{user_id}"
        except Exception:
            # any failure -> fall back to IP
            pass

    return get_remote_address(request)


settings = get_settings()

# Initialize limiter with Redis storage URI from settings
limiter = Limiter(key_func=_key_func, storage_uri=settings.redis_url)

__all__ = ["limiter"]
