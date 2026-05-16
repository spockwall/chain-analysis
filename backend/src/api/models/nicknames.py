"""Pydantic models for the address-nickname API."""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


def _normalize_address(value: str) -> str:
    addr = value.strip().lower()
    if not addr.startswith("0x") or len(addr) != 42:
        raise ValueError("address must be a 0x-prefixed 42-char hex string")
    return addr


class NicknameUpsert(BaseModel):
    """Request body for PUT /api/nicknames/{address}."""

    nickname: str = Field(..., min_length=1, max_length=255)

    @field_validator("nickname")
    @classmethod
    def _strip(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("nickname must not be empty")
        return stripped


class NicknameResponse(BaseModel):
    """A single saved nickname."""

    id: int
    address: str
    nickname: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
