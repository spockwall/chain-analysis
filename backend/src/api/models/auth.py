"""Pydantic models for auth-related API endpoints."""

from pydantic import BaseModel, EmailStr


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
    role: str  # 'admin' | 'operator' | 'user'
    is_active: bool

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    """JWT token + user info returned after successful auth."""

    access_token: str
    token_type: str = "bearer"
    user: UserResponse
