"""Entity features API endpoints.

Provides GET and PUT endpoints for the entity_features PostgreSQL table,
which stores computed on-chain behavioural attributes per entity address.
"""

import json
from decimal import Decimal

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from api.deps import RelationalDBDep
from api.models.entity import EntityFeaturesResponse, EntityFeaturesUpsertRequest

router = APIRouter(prefix="/entities", tags=["entity-features"])


def _validate_address(address: str) -> str:
    """Validate and normalise an Ethereum address."""
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")
    return address.lower()


def _row_to_response(row: dict) -> EntityFeaturesResponse:
    """Convert a database row dict to EntityFeaturesResponse."""
    return EntityFeaturesResponse(
        address=row["address"],
        chain_id=row["chain_id"],
        first_seen_at=row.get("first_seen_at"),
        last_seen_at=row.get("last_seen_at"),
        activity_interval_avg_sec=row.get("activity_interval_avg_sec"),
        active_hour_distribution=row.get("active_hour_distribution"),
        # Numeric columns come back as Decimal — serialise to string for precision
        balance_avg_wei=(
            str(row["balance_avg_wei"])
            if row.get("balance_avg_wei") is not None
            else None
        ),
        balance_max_wei=(
            str(row["balance_max_wei"])
            if row.get("balance_max_wei") is not None
            else None
        ),
        has_deployed_contract=row.get("has_deployed_contract", False),
        is_labeled=row.get("is_labeled", False),
        out_degree=row.get("out_degree", 0),
        in_degree=row.get("in_degree", 0),
        unique_interacted_entities=row.get("unique_interacted_entities", 0),
        same_type_transfer_count=row.get("same_type_transfer_count", 0),
        same_amount_transfer_count=row.get("same_amount_transfer_count", 0),
        volume_in_wei=(
            str(row["volume_in_wei"]) if row.get("volume_in_wei") is not None else None
        ),
        volume_out_wei=(
            str(row["volume_out_wei"])
            if row.get("volume_out_wei") is not None
            else None
        ),
        computed_at=row.get("computed_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("/{address}/features", response_model=EntityFeaturesResponse)
async def get_entity_features(
    address: str,
    db: RelationalDBDep,
) -> EntityFeaturesResponse:
    """
    Get computed on-chain behavioural features for an entity.

    Args:
        address: Ethereum address (0x-prefixed, 42 characters)

    Returns:
        Computed features including activity patterns, balance stats,
        graph topology metrics, and risk indicators.

    Raises:
        404: If no features record exists for this address.
    """
    address = _validate_address(address)

    rows = await db.execute(
        "SELECT * FROM entity_features WHERE address = :address",
        {"address": address},
    )

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No features found for address {address}. "
            "Features are computed by the ETL pipeline.",
        )

    return _row_to_response(rows[0])


@router.put("/{address}/features", response_model=EntityFeaturesResponse)
async def upsert_entity_features(
    address: str,
    body: EntityFeaturesUpsertRequest,
    db: RelationalDBDep,
) -> EntityFeaturesResponse:
    """
    Create or update computed features for an entity (UPSERT).

    Intended to be called by the ETL pipeline (`computed_features` Dagster asset)
    after feature computation. Uses INSERT ... ON CONFLICT DO UPDATE semantics.

    Args:
        address: Ethereum address (0x-prefixed, 42 characters)
        body: Computed feature values

    Returns:
        The upserted feature record.
    """
    address = _validate_address(address)

    params = {
        "address": address,
        "chain_id": body.chain_id,
        "first_seen_at": body.first_seen_at,
        "last_seen_at": body.last_seen_at,
        "activity_interval_avg_sec": body.activity_interval_avg_sec,
        "active_hour_distribution": (
            json.dumps(body.active_hour_distribution)
            if body.active_hour_distribution is not None
            else None
        ),
        "balance_avg_wei": (
            Decimal(body.balance_avg_wei) if body.balance_avg_wei else None
        ),
        "balance_max_wei": (
            Decimal(body.balance_max_wei) if body.balance_max_wei else None
        ),
        "has_deployed_contract": body.has_deployed_contract,
        "is_labeled": body.is_labeled,
        "out_degree": body.out_degree,
        "in_degree": body.in_degree,
        "unique_interacted_entities": body.unique_interacted_entities,
        "same_type_transfer_count": body.same_type_transfer_count,
        "same_amount_transfer_count": body.same_amount_transfer_count,
        "volume_in_wei": Decimal(body.volume_in_wei) if body.volume_in_wei else None,
        "volume_out_wei": Decimal(body.volume_out_wei) if body.volume_out_wei else None,
        "computed_at": body.computed_at,
    }

    sql = text(
        """
        INSERT INTO entity_features (
            address, chain_id,
            first_seen_at, last_seen_at, activity_interval_avg_sec,
            active_hour_distribution,
            balance_avg_wei, balance_max_wei,
            has_deployed_contract, is_labeled,
            out_degree, in_degree, unique_interacted_entities,
            same_type_transfer_count, same_amount_transfer_count,
            volume_in_wei, volume_out_wei,
            computed_at, updated_at
        ) VALUES (
            :address, :chain_id,
            :first_seen_at, :last_seen_at, :activity_interval_avg_sec,
            :active_hour_distribution,
            :balance_avg_wei, :balance_max_wei,
            :has_deployed_contract, :is_labeled,
            :out_degree, :in_degree, :unique_interacted_entities,
            :same_type_transfer_count, :same_amount_transfer_count,
            :volume_in_wei, :volume_out_wei,
            :computed_at, NOW()
        )
        ON CONFLICT (address) DO UPDATE SET
            chain_id                    = EXCLUDED.chain_id,
            first_seen_at               = EXCLUDED.first_seen_at,
            last_seen_at                = EXCLUDED.last_seen_at,
            activity_interval_avg_sec   = EXCLUDED.activity_interval_avg_sec,
            active_hour_distribution    = EXCLUDED.active_hour_distribution,
            balance_avg_wei             = EXCLUDED.balance_avg_wei,
            balance_max_wei             = EXCLUDED.balance_max_wei,
            has_deployed_contract       = EXCLUDED.has_deployed_contract,
            is_labeled                  = EXCLUDED.is_labeled,
            out_degree                  = EXCLUDED.out_degree,
            in_degree                   = EXCLUDED.in_degree,
            unique_interacted_entities  = EXCLUDED.unique_interacted_entities,
            same_type_transfer_count    = EXCLUDED.same_type_transfer_count,
            same_amount_transfer_count  = EXCLUDED.same_amount_transfer_count,
            volume_in_wei               = EXCLUDED.volume_in_wei,
            volume_out_wei              = EXCLUDED.volume_out_wei,
            computed_at                 = EXCLUDED.computed_at,
            updated_at                  = NOW()
        RETURNING *
    """
    )

    # Keep the UPSERT and RETURNING read in one explicit transaction so the
    # returned row reflects the committed write atomically.
    async with db.transaction() as session:
        result = await session.execute(sql, params)
        row = result.mappings().one()

    return _row_to_response(dict(row))
