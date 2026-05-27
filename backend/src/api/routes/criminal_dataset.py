"""Shared criminal dataset endpoints."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from api.deps import GraphDBDep, RelationalDBDep
from api.routes.auth import CurrentUserDep
from db.models import UserRole


router = APIRouter(prefix="/criminal-dataset", tags=["criminal-dataset"])


class CriminalDatasetEntryResponse(BaseModel):
    id: int
    entry_type: Literal["address", "transaction"]
    criminal_address: str | None
    criminal_transaction_hash: str | None
    source_transaction_hash: str | None
    note: str | None
    created_by_user_id: int | None
    created_by_username: str | None
    created_at: datetime
    updated_at: datetime
    can_delete: bool


class CriminalDatasetListResponse(BaseModel):
    entries: list[CriminalDatasetEntryResponse]
    total: int


class CriminalAddressCreateRequest(BaseModel):
    criminal_address: str = Field(..., min_length=42, max_length=42)
    note: str | None = Field(default=None, max_length=2000)


class CriminalTransactionCreateRequest(BaseModel):
    criminal_transaction_hash: str = Field(..., min_length=66, max_length=66)
    note: str | None = Field(default=None, max_length=2000)


class CriminalDatasetCreateResponse(BaseModel):
    entries: list[CriminalDatasetEntryResponse]
    created: int
    existing: int


def _validate_address(address: str) -> str:
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")
    return address.lower()


def _validate_hash(tx_hash: str) -> str:
    if not tx_hash.startswith("0x") or len(tx_hash) != 66:
        raise HTTPException(status_code=400, detail="Invalid transaction hash format")
    return tx_hash.lower()


def _can_delete(row: dict, current_user) -> bool:
    return (
        current_user.role == UserRole.ADMIN.value
        or row["created_by_user_id"] == current_user.id
    )


def _row_to_response(row: dict, current_user) -> CriminalDatasetEntryResponse:
    entry_type: Literal["address", "transaction"] = (
        "address" if row["criminal_address"] else "transaction"
    )
    return CriminalDatasetEntryResponse(
        id=row["id"],
        entry_type=entry_type,
        criminal_address=row["criminal_address"],
        criminal_transaction_hash=row["criminal_transaction_hash"],
        source_transaction_hash=row["source_transaction_hash"],
        note=row["note"],
        created_by_user_id=row["created_by_user_id"],
        created_by_username=row["created_by_username"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        can_delete=_can_delete(row, current_user),
    )


async def _fetch_entries_by_ids(session, ids: list[int], current_user) -> list[CriminalDatasetEntryResponse]:
    if not ids:
        return []

    result = await session.execute(
        text(
            """
            SELECT e.id, e.criminal_address, e.criminal_transaction_hash,
                   e.source_transaction_hash, e.note, e.created_by_user_id,
                   u.username AS created_by_username, e.created_at, e.updated_at
            FROM criminal_dataset_entries e
            LEFT JOIN users u ON u.id = e.created_by_user_id
            WHERE e.id = ANY(:ids)
            ORDER BY e.created_at DESC, e.id DESC
            """
        ),
        {"ids": ids},
    )
    return [_row_to_response(dict(row), current_user) for row in result.mappings().all()]


async def _insert_address_entry(
    session,
    *,
    address: str,
    user_id: int,
    note: str | None,
    source_transaction_hash: str | None = None,
) -> tuple[int, bool]:
    result = await session.execute(
        text(
            """
            INSERT INTO criminal_dataset_entries (
                criminal_address, source_transaction_hash, note, created_by_user_id
            )
            VALUES (:address, :source_transaction_hash, :note, :user_id)
            ON CONFLICT (criminal_address) DO NOTHING
            RETURNING id
            """
        ),
        {
            "address": address,
            "source_transaction_hash": source_transaction_hash,
            "note": note,
            "user_id": user_id,
        },
    )
    row = result.mappings().first()
    if row:
        return row["id"], True

    existing = await session.execute(
        text(
            """
            SELECT id
            FROM criminal_dataset_entries
            WHERE criminal_address = :address
            """
        ),
        {"address": address},
    )
    return existing.mappings().one()["id"], False


async def _insert_transaction_entry(
    session,
    *,
    tx_hash: str,
    user_id: int,
    note: str | None,
) -> tuple[int, bool]:
    result = await session.execute(
        text(
            """
            INSERT INTO criminal_dataset_entries (
                criminal_transaction_hash, note, created_by_user_id
            )
            VALUES (:tx_hash, :note, :user_id)
            ON CONFLICT (criminal_transaction_hash) DO NOTHING
            RETURNING id
            """
        ),
        {"tx_hash": tx_hash, "note": note, "user_id": user_id},
    )
    row = result.mappings().first()
    if row:
        return row["id"], True

    existing = await session.execute(
        text(
            """
            SELECT id
            FROM criminal_dataset_entries
            WHERE criminal_transaction_hash = :tx_hash
            """
        ),
        {"tx_hash": tx_hash},
    )
    return existing.mappings().one()["id"], False


@router.get("", response_model=CriminalDatasetListResponse)
async def list_criminal_dataset(
    db: RelationalDBDep,
    current_user: CurrentUserDep,
    limit: int = 500,
    offset: int = 0,
) -> CriminalDatasetListResponse:
    """List the shared criminal dataset."""
    if limit < 1 or limit > 1000:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 1000")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")

    async with db.session() as session:
        total_result = await session.execute(
            text("SELECT count(*) AS total FROM criminal_dataset_entries")
        )
        total = total_result.mappings().one()["total"]
        result = await session.execute(
            text(
                """
                SELECT e.id, e.criminal_address, e.criminal_transaction_hash,
                       e.source_transaction_hash, e.note, e.created_by_user_id,
                       u.username AS created_by_username, e.created_at, e.updated_at
                FROM criminal_dataset_entries e
                LEFT JOIN users u ON u.id = e.created_by_user_id
                ORDER BY e.created_at DESC, e.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {"limit": limit, "offset": offset},
        )
        rows = [dict(row) for row in result.mappings().all()]

    return CriminalDatasetListResponse(
        entries=[_row_to_response(row, current_user) for row in rows],
        total=total,
    )


@router.post(
    "/addresses",
    response_model=CriminalDatasetCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_criminal_address(
    body: CriminalAddressCreateRequest,
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> CriminalDatasetCreateResponse:
    """Add a suspicious address to the shared dataset."""
    address = _validate_address(body.criminal_address)
    async with db.transaction() as session:
        entry_id, created = await _insert_address_entry(
            session,
            address=address,
            user_id=current_user.id,
            note=body.note,
        )
        entries = await _fetch_entries_by_ids(session, [entry_id], current_user)

    return CriminalDatasetCreateResponse(
        entries=entries,
        created=1 if created else 0,
        existing=0 if created else 1,
    )


@router.post(
    "/transactions",
    response_model=CriminalDatasetCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_criminal_transaction(
    body: CriminalTransactionCreateRequest,
    db: RelationalDBDep,
    graph_db: GraphDBDep,
    current_user: CurrentUserDep,
) -> CriminalDatasetCreateResponse:
    """
    Add a suspicious transaction and automatically add both endpoint accounts.

    The transaction must already exist in Neo4j so the API can resolve its
    from/to accounts deterministically.
    """
    tx_hash = _validate_hash(body.criminal_transaction_hash)
    tx = await graph_db.get_transaction(tx_hash)
    if tx is None:
        raise HTTPException(
            status_code=404,
            detail="Transaction not found in graph; ingest it before adding it to the dataset",
        )

    endpoint_addresses = []
    for addr in [tx.from_address, tx.to_address]:
        if addr and addr.startswith("0x") and len(addr) == 42:
            normalized = addr.lower()
            if normalized not in endpoint_addresses:
                endpoint_addresses.append(normalized)

    if not endpoint_addresses:
        raise HTTPException(
            status_code=409,
            detail="Transaction has no resolvable endpoint accounts",
        )

    ids: list[int] = []
    created_count = 0
    async with db.transaction() as session:
        tx_entry_id, tx_created = await _insert_transaction_entry(
            session,
            tx_hash=tx_hash,
            user_id=current_user.id,
            note=body.note,
        )
        ids.append(tx_entry_id)
        created_count += 1 if tx_created else 0

        for address in endpoint_addresses:
            address_entry_id, address_created = await _insert_address_entry(
                session,
                address=address,
                user_id=current_user.id,
                note=f"Auto-added from transaction {tx_hash}",
                source_transaction_hash=tx_hash,
            )
            ids.append(address_entry_id)
            created_count += 1 if address_created else 0

        entries = await _fetch_entries_by_ids(session, ids, current_user)

    return CriminalDatasetCreateResponse(
        entries=entries,
        created=created_count,
        existing=len(ids) - created_count,
    )


@router.delete("/{entry_id}", status_code=204, response_model=None)
async def delete_criminal_dataset_entry(
    entry_id: int,
    db: RelationalDBDep,
    current_user: CurrentUserDep,
) -> None:
    """Delete one dataset entry if the caller is its creator or an admin."""
    async with db.transaction() as session:
        result = await session.execute(
            text(
                """
                SELECT id, created_by_user_id
                FROM criminal_dataset_entries
                WHERE id = :entry_id
                """
            ),
            {"entry_id": entry_id},
        )
        row = result.mappings().first()
        if row is None:
            raise HTTPException(status_code=404, detail="Dataset entry not found")

        if (
            current_user.role != UserRole.ADMIN.value
            and row["created_by_user_id"] != current_user.id
        ):
            raise HTTPException(
                status_code=403,
                detail="Only the entry creator or an admin can delete this entry",
            )

        await session.execute(
            text("DELETE FROM criminal_dataset_entries WHERE id = :entry_id"),
            {"entry_id": entry_id},
        )
