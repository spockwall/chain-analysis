"""Favorite-paths API — per-user saved (source, target) bookmarks."""

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from api.deps import RelationalDBDep
from api.models.favorites import FavoritePathCreate, FavoritePathResponse
from api.routes.auth import CurrentUserDep
from db.models import FavoritePath

router = APIRouter(prefix="/favorites", tags=["favorites"])


@router.get("", response_model=list[FavoritePathResponse])
async def list_favorite_paths(
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> list[FavoritePathResponse]:
    """Return the current user's favorite paths, newest first."""
    async with db.session() as session:
        result = await session.execute(
            select(FavoritePath)
            .where(FavoritePath.user_id == current_user.id)
            .order_by(FavoritePath.created_at.desc(), FavoritePath.id.desc())
        )
        rows = list(result.scalars().all())

    return [FavoritePathResponse.model_validate(row) for row in rows]


@router.post(
    "",
    response_model=FavoritePathResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_favorite_path(
    body: FavoritePathCreate,
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> FavoritePathResponse:
    """Save a new favorite path for the current user."""
    favorite = FavoritePath(
        user_id=current_user.id,
        source=body.source,
        target=body.target,
        label=body.label,
    )

    async with db.transaction() as session:
        session.add(favorite)
        try:
            await session.flush()
        except IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Path is already in favorites",
            )
        await session.refresh(favorite)
        response = FavoritePathResponse.model_validate(favorite)

    return response


@router.delete(
    "/{favorite_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
async def delete_favorite_path(
    favorite_id: int,
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> None:
    """Delete one of the current user's favorite paths."""
    async with db.transaction() as session:
        favorite = await session.get(FavoritePath, favorite_id)
        if favorite is None or favorite.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Favorite path not found",
            )
        await session.delete(favorite)
