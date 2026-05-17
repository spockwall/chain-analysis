"""
Auth API routes plus shared authentication dependencies.
"""

from datetime import timedelta, datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from api.deps import RelationalDBDep, SettingsDep
from api.models.auth import LoginRequest, RegisterRequest, TokenResponse, UserResponse
from db.models import User, UserRole, RefreshToken
from services.auth import (
    create_access_token,
    decode_access_token,
    generate_refresh_token_plaintext,
    hash_refresh_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _make_token(user: User, settings) -> str:
    return create_access_token(
        data={"sub": str(user.id), "email": user.email, "role": user.role},
        secret_key=settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
    )


async def get_current_user(
    request: Request,
    db: RelationalDBDep,
    settings: SettingsDep,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> User:
    """Return the authenticated active user.

    Prefer the access token from the httpOnly cookie, fall back to Authorization header.
    """
    token = None
    # cookie-first
    cookie_token = request.cookies.get(settings.access_token_cookie_name)
    if cookie_token:
        token = cookie_token

    # fallback to Authorization bearer
    if token is None and credentials is not None:
        token = credentials.credentials

    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_access_token(token, settings.jwt_secret_key, settings.jwt_algorithm)
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise ValueError("missing sub")
    except (JWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
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
    "/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED
)
async def register(
    body: RegisterRequest,
    response: Response,
    db: RelationalDBDep,
    settings: SettingsDep,
) -> TokenResponse:
    """Create a new user account and return a JWT."""
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

    token = _make_token(new_user, settings)
    # create refresh token record and set cookies
    refresh_plain = generate_refresh_token_plaintext()
    refresh_hash = hash_refresh_token(refresh_plain)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    async with db.transaction() as session:
        from db.models import RefreshToken as RT

        rt = RT(user_id=new_user.id, token_hash=refresh_hash, expires_at=expires_at)
        session.add(rt)
        await session.flush()

    secure_cookie = settings.environment != "local"
    response.set_cookie(
        settings.refresh_token_cookie_name,
        refresh_plain,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/",
    )
    # also set short-lived access token cookie
    response.set_cookie(
        settings.access_token_cookie_name,
        token,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=settings.access_token_expire_minutes * 60,
        path="/",
    )
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(new_user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    response: Response,
    db: RelationalDBDep,
    settings: SettingsDep,
) -> TokenResponse:
    """Authenticate with email + password and return a JWT."""
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

    token = _make_token(user, settings)
    # create refresh token record and set cookies
    refresh_plain = generate_refresh_token_plaintext()
    refresh_hash = hash_refresh_token(refresh_plain)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    async with db.transaction() as session:
        from db.models import RefreshToken as RT

        rt = RT(user_id=user.id, token_hash=refresh_hash, expires_at=expires_at)
        session.add(rt)
        await session.flush()

    secure_cookie = settings.environment != "local"
    response.set_cookie(
        settings.refresh_token_cookie_name,
        refresh_plain,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/",
    )
    response.set_cookie(
        settings.access_token_cookie_name,
        token,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=settings.access_token_expire_minutes * 60,
        path="/",
    )

    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: CurrentUserDep,
) -> UserResponse:
    """Return the profile of the currently authenticated user."""
    return UserResponse.model_validate(current_user)



@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    response: Response,
    db: RelationalDBDep,
    settings: SettingsDep,
) -> TokenResponse:
    """Exchange a valid refresh cookie for a new access token (and rotate refresh token)."""
    refresh_plain = request.cookies.get(settings.refresh_token_cookie_name)
    if not refresh_plain:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing refresh token")

    hashed = hash_refresh_token(refresh_plain)
    async with db.transaction() as session:
        result = await session.execute(select(RefreshToken).where(RefreshToken.token_hash == hashed))
        rt = result.scalar_one_or_none()
        if rt is None or rt.revoked or rt.expires_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

        # find user
        user = await session.get(User, int(rt.user_id))
        if user is None or not user.is_active:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

        # rotate refresh token
        new_plain = generate_refresh_token_plaintext()
        new_hash = hash_refresh_token(new_plain)
        new_expires = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
        from db.models import RefreshToken as RT

        new_rt = RT(user_id=user.id, token_hash=new_hash, expires_at=new_expires)
        session.add(new_rt)
        await session.flush()

        # revoke old
        rt.revoked = True
        rt.replaced_by = new_rt.id
        rt.last_used_at = datetime.now(timezone.utc)

    # issue new access token
    token = _make_token(user, settings)
    secure_cookie = settings.environment != "local"
    response.set_cookie(
        settings.refresh_token_cookie_name,
        new_plain,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/",
    )
    response.set_cookie(
        settings.access_token_cookie_name,
        token,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=settings.access_token_expire_minutes * 60,
        path="/",
    )

    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))



@router.post("/logout")
async def logout(request: Request, response: Response, db: RelationalDBDep, settings: SettingsDep):
    """Revoke refresh token and clear cookies."""
    refresh_plain = request.cookies.get(settings.refresh_token_cookie_name)
    if refresh_plain:
        hashed = hash_refresh_token(refresh_plain)
        async with db.transaction() as session:
            result = await session.execute(select(RefreshToken).where(RefreshToken.token_hash == hashed))
            rt = result.scalar_one_or_none()
            if rt:
                rt.revoked = True

    # clear cookies
    response.set_cookie(settings.refresh_token_cookie_name, "", max_age=0, expires=0, path="/")
    response.set_cookie(settings.access_token_cookie_name, "", max_age=0, expires=0, path="/")
    return {"detail": "Logged out"}
