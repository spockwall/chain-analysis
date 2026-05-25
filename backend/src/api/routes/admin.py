"""Admin API routes for managing application users."""

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from api.deps import RelationalDBDep
from api.models.auth import (
    ManagedUserCreateRequest,
    ManagedUserUpdateRequest,
    UserListResponse,
    UserResponse,
)
from db.models import User, UserRole
from .auth import AdminUserDep
from services.auth import hash_password

router = APIRouter(prefix="/admin", tags=["admin"])


def _clean_username(username: str) -> str:
    cleaned = username.strip()
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Username cannot be empty",
        )
    return cleaned


def _clean_password(password: str) -> str:
    if password == "":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password cannot be empty",
        )
    return password


def _normalize_email(email: str) -> str:
    return email.lower().strip()


@router.get("/users", response_model=UserListResponse)
async def list_users(
    db: RelationalDBDep,
    _: AdminUserDep,
) -> UserListResponse:
    """Return all application users for the admin console."""
    async with db.session() as session:
        result = await session.execute(
            select(User).order_by(User.role.asc(), User.created_at.asc(), User.id.asc())
        )
        users = list(result.scalars().all())

    return UserListResponse(
        users=[UserResponse.model_validate(user) for user in users],
        total=len(users),
    )


@router.get("/users/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: RelationalDBDep,
    _: AdminUserDep,
) -> UserResponse:
    """Return a single user for the admin console."""
    async with db.session() as session:
        user = await session.get(User, user_id)

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    return UserResponse.model_validate(user)


@router.post(
    "/users",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_user(
    body: ManagedUserCreateRequest,
    db: RelationalDBDep,
    _: AdminUserDep,
) -> UserResponse:
    """Create a new operator, user, or admin account."""
    new_user = User(
        username=_clean_username(body.username),
        email=_normalize_email(body.email),
        hashed_password=hash_password(_clean_password(body.password)),
        role=body.role.value,
        is_active=body.is_active,
    )

    async with db.transaction() as session:
        session.add(new_user)
        try:
            await session.flush()
        except IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email or username already registered",
            )
        await session.refresh(new_user)
        response = UserResponse.model_validate(new_user)

    return response


@router.patch("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    body: ManagedUserUpdateRequest,
    db: RelationalDBDep,
    current_admin: AdminUserDep,
) -> UserResponse:
    """Update an existing user account."""
    async with db.transaction() as session:
        user = await session.get(User, user_id)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )

        if current_admin.id == user.id:
            if body.is_active is False:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="You cannot deactivate your own account",
                )
            if body.role is not None and body.role != UserRole.ADMIN:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="You cannot remove your own admin role",
                )

        if body.username is not None:
            user.username = _clean_username(body.username)
        if body.email is not None:
            user.email = _normalize_email(body.email)
        if body.password is not None:
            user.hashed_password = hash_password(_clean_password(body.password))
        if body.role is not None:
            user.role = body.role.value
        if body.is_active is not None:
            user.is_active = body.is_active

        try:
            await session.flush()
        except IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email or username already registered",
            )
        await session.refresh(user)
        response = UserResponse.model_validate(user)

    return response


@router.delete(
    "/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
async def delete_user(
    user_id: int,
    db: RelationalDBDep,
    current_admin: AdminUserDep,
) -> None:
    """Delete a user account."""
    if current_admin.id == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account",
        )

    async with db.transaction() as session:
        user = await session.get(User, user_id)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )
        await session.delete(user)
