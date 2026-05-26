"""Rate limiter initialization using slowapi + Redis storage.

Keying strategy: if a valid JWT is present in either the Authorization bearer
header or auth cookie, use `user:{sub}`; otherwise fall back to remote IP.
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
    token = request.cookies.get("access_token")
    if auth.startswith("Bearer "):
        token = auth.split(" ", 1)[1]

    if token:
        try:
            settings = get_settings()
            payload = decode_access_token(
                token,
                settings.jwt_validation_secret_keys,
                settings.jwt_algorithm,
            )
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
