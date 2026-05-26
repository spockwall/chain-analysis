"""Tests for JWT secret rotation helpers."""

from datetime import timedelta

import pytest
from fastapi import HTTPException
from jose import JWTError
from starlette.requests import Request

from src.api.routes.auth import _validate_csrf
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

    def test_decode_accepts_single_secret_string(self):
        """Legacy callers can still pass a single JWT secret string."""
        token = create_access_token(
            data={"sub": "456"},
            secret_key="new-secret",
            algorithm="HS256",
            expires_delta=timedelta(minutes=5),
        )

        payload = decode_access_token(token, "new-secret", "HS256")

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


class TestCsrfValidation:
    def test_validate_csrf_accepts_matching_header_cookie_and_claim(self):
        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/auth/logout",
                "headers": [
                    (b"x-csrf-token", b"csrf-value"),
                    (b"cookie", b"csrf_token=csrf-value"),
                ],
            }
        )

        _validate_csrf(request, {"csrf": "csrf-value"})

    def test_validate_csrf_rejects_missing_header(self):
        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/auth/logout",
                "headers": [(b"cookie", b"csrf_token=csrf-value")],
            }
        )

        with pytest.raises(HTTPException):
            _validate_csrf(request, {"csrf": "csrf-value"})
