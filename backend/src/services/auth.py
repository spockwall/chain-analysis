"""
Authentication service: password hashing (bcrypt) and JWT creation / decoding.

Pure functions with no FastAPI dependencies — importable by routes and tests.
"""

from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt  # noqa: F401 – re-exported for callers
import hashlib
import secrets


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    """Return a bcrypt hash of *plain*."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if *plain* matches the *hashed* bcrypt digest."""
    return bcrypt.checkpw(plain.encode(), hashed.encode())


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------


def create_access_token(
    data: dict,
    secret_key: str,
    algorithm: str,
    expires_delta: timedelta | None = None,
) -> str:
    """Create a signed JWT carrying *data* as the payload.

    The ``"exp"`` claim is set to *expires_delta* from now (defaults to 24 h).
    """
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(hours=24))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, secret_key, algorithm=algorithm)


def decode_access_token(token: str, secret_key: str, algorithm: str) -> dict:
    """Decode and verify a JWT, returning its payload as a dict.

    Raises :class:`jose.JWTError` if the token is invalid or expired.
    """
    return jwt.decode(token, secret_key, algorithms=[algorithm])


# ---------------------------------------------------------------------------
# Refresh token helpers
# ---------------------------------------------------------------------------


def generate_refresh_token_plaintext(length: int = 48) -> str:
    """Generate a secure random refresh token (plaintext)."""
    return secrets.token_urlsafe(length)


def hash_refresh_token(token_plain: str) -> str:
    """Return a sha256 hex digest of the refresh token for DB storage."""
    return hashlib.sha256(token_plain.encode()).hexdigest()


__all__ = [
    "hash_password",
    "verify_password",
    "create_access_token",
    "decode_access_token",
    "generate_refresh_token_plaintext",
    "hash_refresh_token",
]
