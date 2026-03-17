"""Pydantic models for auth-related API endpoints."""

from datetime import datetime

from pydantic import BaseModel, EmailStr

from db.models import UserRole


class RegisterRequest(BaseModel):
    """Request body for POST /api/auth/register."""

    username: str
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    """Request body for POST /api/auth/login."""

    email: EmailStr
    password: str


class UserResponse(BaseModel):
    """Public user representation returned by auth endpoints."""

    id: int
    username: str
    email: str
    role: UserRole
    is_active: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    """JWT token + user info returned after successful auth."""

    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class ManagedUserCreateRequest(BaseModel):
    """Request body for POST /api/admin/users."""

    username: str
    email: EmailStr
    password: str
    role: UserRole = UserRole.USER
    is_active: bool = True


class ManagedUserUpdateRequest(BaseModel):
    """Request body for PATCH /api/admin/users/{user_id}."""

    username: str | None = None
    email: EmailStr | None = None
    password: str | None = None
    role: UserRole | None = None
    is_active: bool | None = None


class UserListResponse(BaseModel):
    """Collection response for admin user management."""

    users: list[UserResponse]
    total: int
