"""
Auth API routes: register, login, and current-user.
"""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
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


def _make_token(user: User, settings) -> str:
    return create_access_token(
        data={"sub": str(user.id), "email": user.email, "role": user.role},
        secret_key=settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED
)
async def register(
    body: RegisterRequest,
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
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(new_user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
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
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.get("/me", response_model=UserResponse)
async def get_me(
    db: RelationalDBDep,
    settings: SettingsDep,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserResponse:
    """Return the profile of the currently authenticated user."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_access_token(
            credentials.credentials,
            settings.jwt_secret_key,
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

    return UserResponse.model_validate(user)
