"""Pydantic models for the favorite-paths API."""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


def _normalize_address(value: str) -> str:
    addr = value.strip().lower()
    if not addr.startswith("0x") or len(addr) != 42:
        raise ValueError("address must be a 0x-prefixed 42-char hex string")
    return addr


class FavoritePathCreate(BaseModel):
    """Request body for POST /api/favorites."""

    source: str
    target: str
    label: str | None = Field(default=None, max_length=255)

    @field_validator("source", "target")
    @classmethod
    def _validate_addr(cls, v: str) -> str:
        return _normalize_address(v)


class FavoritePathResponse(BaseModel):
    """A single saved favorite path."""

    id: int
    source: str
    target: str
    label: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
