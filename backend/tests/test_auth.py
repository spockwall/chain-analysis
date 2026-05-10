"""Tests for JWT secret rotation helpers."""

from datetime import timedelta

import pytest
from jose import JWTError

from src.services.auth import create_access_token, decode_access_token


class TestJwtRotation:
    """JWT rotation behaviour should accept the current and previous secret."""

    def test_decode_accepts_previous_secret(self):
        """Tokens signed before rotation remain valid during the overlap window."""
        token = create_access_token(
            data={"sub": "123", "email": "user@example.com"},
            secret_key="old-secret",
            algorithm="HS256",
            expires_delta=timedelta(minutes=5),
        )

        payload = decode_access_token(token, ["new-secret", "old-secret"], "HS256")

        assert payload["sub"] == "123"
        assert payload["email"] == "user@example.com"

    def test_decode_prefers_current_secret_for_new_tokens(self):
        """New tokens should verify against the active secret."""
        token = create_access_token(
            data={"sub": "456"},
            secret_key="new-secret",
            algorithm="HS256",
            expires_delta=timedelta(minutes=5),
        )

        payload = decode_access_token(token, ["new-secret", "old-secret"], "HS256")

        assert payload["sub"] == "456"

    def test_decode_rejects_unknown_secret(self):
        """Tokens signed with an unrecognised secret should still fail."""
        token = create_access_token(
            data={"sub": "789"},
            secret_key="unexpected-secret",
            algorithm="HS256",
            expires_delta=timedelta(minutes=5),
        )

        with pytest.raises(JWTError):
            decode_access_token(token, ["new-secret", "old-secret"], "HS256")