"""Address-nickname API — per-user private aliases for on-chain addresses."""

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from api.deps import RelationalDBDep
from api.models.nicknames import NicknameResponse, NicknameUpsert
from api.routes.auth import CurrentUserDep
from db.models import AddressNickname

router = APIRouter(prefix="/nicknames", tags=["nicknames"])


def _validate_address(addr: str) -> str:
    normalized = addr.strip().lower()
    if not normalized.startswith("0x") or len(normalized) != 42:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="address must be a 0x-prefixed 42-char hex string",
        )
    return normalized


@router.get("", response_model=list[NicknameResponse])
async def list_nicknames(
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> list[NicknameResponse]:
    """Return all of the current user's nicknames."""
    async with db.session() as session:
        result = await session.execute(
            select(AddressNickname)
            .where(AddressNickname.user_id == current_user.id)
            .order_by(AddressNickname.updated_at.desc())
        )
        rows = list(result.scalars().all())

    return [NicknameResponse.model_validate(row) for row in rows]


@router.put("/{address}", response_model=NicknameResponse)
async def upsert_nickname(
    address: str,
    body: NicknameUpsert,
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> NicknameResponse:
    """Create or update the current user's nickname for `address`."""
    addr = _validate_address(address)

    async with db.transaction() as session:
        existing_q = await session.execute(
            select(AddressNickname).where(
                AddressNickname.user_id == current_user.id,
                AddressNickname.address == addr,
            )
        )
        existing = existing_q.scalar_one_or_none()

        if existing is None:
            row = AddressNickname(
                user_id=current_user.id,
                address=addr,
                nickname=body.nickname,
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            response = NicknameResponse.model_validate(row)
        else:
            existing.nickname = body.nickname
            await session.flush()
            await session.refresh(existing)
            response = NicknameResponse.model_validate(existing)

    return response


@router.delete(
    "/{address}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
async def delete_nickname(
    address: str,
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> None:
    """Remove the current user's nickname for `address`."""
    addr = _validate_address(address)

    async with db.transaction() as session:
        result = await session.execute(
            select(AddressNickname).where(
                AddressNickname.user_id == current_user.id,
                AddressNickname.address == addr,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Nickname not found",
            )
        await session.delete(row)
