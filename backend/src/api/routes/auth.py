"""
Auth API routes plus shared authentication dependencies.
"""

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from api.deps import RelationalDBDep, SettingsDep
from api.models.auth import LoginRequest, RegisterRequest, TokenResponse, UserResponse
from db.models import User, UserRole
from services.auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _set_auth_cookie(response: Response, user: User, settings) -> None:
    """Create and set a JWT auth token as an httpOnly, secure cookie."""
    token = create_access_token(
        data={"sub": str(user.id), "email": user.email, "role": user.role},
        secret_key=settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
    )
    response.set_cookie(
        key="access_token",
        value=token,
        max_age=settings.access_token_expire_minutes * 60,
        httponly=True,
        secure=settings.environment == "production",
        samesite="lax",
    )


async def get_current_user(
    db: RelationalDBDep,
    settings: SettingsDep,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> User:
    """Return the authenticated active user from the bearer token."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_access_token(
            credentials.credentials,
            settings.jwt_validation_secret_keys,
            settings.jwt_algorithm,
        )
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


@router.post("/logout")
async def logout() -> dict:
    """Logout and clear the auth cookie."""
    response = Response(content=b'{"message": "Logged out"}')
    response.headers["content-type"] = "application/json"
    response.delete_cookie(
        key="access_token",
        httponly=True,
        secure=True,
        samesite="lax",
    )
    return response
