"""
Auth API routes plus shared authentication dependencies.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from api.deps import RelationalDBDep, SettingsDep
from api.models.auth import LoginRequest, LogoutResponse, RegisterRequest, UserResponse
from db.models import RevokedToken, User, UserRole
from services.auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=False)
ACCESS_TOKEN_COOKIE = "access_token"
CSRF_TOKEN_COOKIE = "csrf_token"
CSRF_TOKEN_HEADER = "X-CSRF-Token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _cookie_secure(settings) -> bool:
    return settings.environment == "production"


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _extract_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
) -> tuple[str | None, str | None]:
    cookie_token = request.cookies.get(ACCESS_TOKEN_COOKIE)
    if cookie_token:
        return cookie_token, "cookie"
    if credentials:
        return credentials.credentials, "bearer"
    return None, None


def _validate_csrf(request: Request, payload: dict) -> None:
    expected = payload.get("csrf")
    header_token = request.headers.get(CSRF_TOKEN_HEADER)
    cookie_token = request.cookies.get(CSRF_TOKEN_COOKIE)
    if (
        not isinstance(expected, str)
        or not header_token
        or not cookie_token
        or not secrets.compare_digest(header_token, cookie_token)
        or not secrets.compare_digest(header_token, expected)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF token missing or invalid",
        )


def _set_csrf_cookie(response: Response, csrf_token: str, settings) -> None:
    response.set_cookie(
        key=CSRF_TOKEN_COOKIE,
        value=csrf_token,
        max_age=settings.access_token_expire_minutes * 60,
        httponly=False,
        secure=_cookie_secure(settings),
        samesite="lax",
    )


def _clear_auth_cookies(response: Response, settings) -> None:
    response.delete_cookie(
        key=ACCESS_TOKEN_COOKIE,
        httponly=True,
        secure=_cookie_secure(settings),
        samesite="lax",
    )
    response.delete_cookie(
        key=CSRF_TOKEN_COOKIE,
        httponly=False,
        secure=_cookie_secure(settings),
        samesite="lax",
    )


async def _is_token_revoked(db: RelationalDBDep, token: str) -> bool:
    async with db.session() as session:
        result = await session.execute(
            select(RevokedToken.id).where(RevokedToken.token_hash == _token_hash(token))
        )
        return result.scalar_one_or_none() is not None


def _token_expiry(payload: dict, settings) -> datetime:
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        return datetime.fromtimestamp(exp, timezone.utc)
    return datetime.now(timezone.utc) + timedelta(
        minutes=settings.access_token_expire_minutes
    )


async def _revoke_token(
    db: RelationalDBDep,
    token: str,
    payload: dict,
    settings,
) -> None:
    user_id = payload.get("sub")
    try:
        user_id_value = int(user_id) if user_id is not None else None
    except (TypeError, ValueError):
        user_id_value = None

    await db.execute(
        """
        INSERT INTO revoked_tokens (token_hash, user_id, expires_at)
        VALUES (:token_hash, :user_id, :expires_at)
        ON CONFLICT (token_hash) DO NOTHING
        """,
        {
            "token_hash": _token_hash(token),
            "user_id": user_id_value,
            "expires_at": _token_expiry(payload, settings),
        },
    )


def _set_auth_cookie(response: Response, user: User, settings) -> None:
    """Create and set a JWT auth token as an httpOnly, secure cookie."""
    csrf_token = secrets.token_urlsafe(32)
    token = create_access_token(
        data={
            "sub": str(user.id),
            "email": user.email,
            "role": user.role,
            "csrf": csrf_token,
        },
        secret_key=settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
    )
    response.set_cookie(
        key=ACCESS_TOKEN_COOKIE,
        value=token,
        max_age=settings.access_token_expire_minutes * 60,
        httponly=True,
        secure=_cookie_secure(settings),
        samesite="lax",
    )
    _set_csrf_cookie(response, csrf_token, settings)


async def get_current_user(
    request: Request,
    db: RelationalDBDep,
    settings: SettingsDep,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> User:
    """Return the authenticated active user from httpOnly cookie or Bearer token.
    
    Tries to extract token in order:
    1. httpOnly cookie 'access_token' (preferred, XSS-safe)
    2. Authorization: Bearer ... header (fallback, API compatibility)
    """
    token, token_source = _extract_token(request, credentials)

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_access_token(
            token,
            settings.jwt_validation_secret_keys,
            settings.jwt_algorithm,
        )
        if token_source == "cookie" and request.method.upper() not in SAFE_METHODS:
            _validate_csrf(request, payload)
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise ValueError("missing sub")
    except (JWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if await _is_token_revoked(db, token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has been revoked",
            headers={"WWW-Authenticate": "Bearer"},
        )

    async with db.session() as session:
        user = await session.get(User, int(user_id))

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    return user


async def require_admin_user(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    """Require that the authenticated user has the admin role."""
    if current_user.role != UserRole.ADMIN.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return current_user


CurrentUserDep = Annotated[User, Depends(get_current_user)]
AdminUserDep = Annotated[User, Depends(require_admin_user)]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED
)
async def register(
    body: RegisterRequest,
    response: Response,
    db: RelationalDBDep,
    settings: SettingsDep,
) -> UserResponse:
    """Create a new user account and set an auth cookie."""
    hashed = hash_password(body.password)
    new_user = User(
        username=body.username.strip(),
        email=body.email.lower().strip(),
        hashed_password=hashed,
        role=UserRole.USER,  # All self-registered accounts start as 'user'
    )
    async with db.transaction() as session:
        session.add(new_user)
        try:
            await session.flush()  # get the generated id before commit
        except IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email or username already registered",
            )

    _set_auth_cookie(response, new_user, settings)
    return UserResponse.model_validate(new_user)


@router.post("/login", response_model=UserResponse)
async def login(
    body: LoginRequest,
    response: Response,
    db: RelationalDBDep,
    settings: SettingsDep,
) -> UserResponse:
    """Authenticate with email + password and set an auth cookie."""
    async with db.session() as session:
        result = await session.execute(
            select(User).where(User.email == body.email.lower().strip())
        )
        user = result.scalar_one_or_none()

    if user is None or not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is disabled",
        )

    _set_auth_cookie(response, user, settings)
    return UserResponse.model_validate(user)


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: CurrentUserDep,
) -> UserResponse:
    """Return the profile of the currently authenticated user."""
    return UserResponse.model_validate(current_user)


@router.post("/logout", response_model=LogoutResponse)
async def logout(
    request: Request,
    response: Response,
    db: RelationalDBDep,
    settings: SettingsDep,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> LogoutResponse:
    """Logout, revoke the current JWT, and clear auth cookies."""
    token, token_source = _extract_token(request, credentials)
    if token:
        try:
            payload = decode_access_token(
                token,
                settings.jwt_validation_secret_keys,
                settings.jwt_algorithm,
            )
            if token_source == "cookie" and payload.get("csrf") is not None:
                _validate_csrf(request, payload)
            await _revoke_token(db, token, payload, settings)
        except HTTPException:
            raise
        except (JWTError, ValueError):
            pass

    _clear_auth_cookies(response, settings)
    return LogoutResponse(message="Logged out")
