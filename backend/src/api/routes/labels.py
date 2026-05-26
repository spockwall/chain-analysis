"""Labeling workflow API endpoints."""

import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from api.deps import MessageQueueDep, RelationalDBDep, SettingsDep
from libs.rate_limiter import limiter
from core.config import get_settings
from api.models.entity import (
    AnnotationCreate,
    AnnotationResponse,
    LabelTaskCreate,
    LabelTaskResponse,
)
from db.models import Annotation, LabelTask, TaskStatus

router = APIRouter(prefix="/labels", tags=["labels"])


class LabelFetchRequest(BaseModel):
    """Enqueue targeted ingestion work for the etl-rs ingest worker."""

    mode: Literal["addresses", "hashes", "neighborhood"] = "addresses"
    addresses: list[str] = Field(default_factory=list)
    hashes: list[str] = Field(default_factory=list)
    seed: str | None = None
    hops: int = Field(default=1, ge=0, le=4)


class LabelFetchResponse(BaseModel):
    task_ids: list[int]
    queued: int


def _validate_address(addr: str) -> str:
    if not addr.startswith("0x") or len(addr) != 42:
        raise HTTPException(status_code=400, detail=f"Invalid address: {addr}")
    return addr.lower()


def _validate_hash(h: str) -> str:
    if not h.startswith("0x") or len(h) != 66:
        raise HTTPException(status_code=400, detail=f"Invalid tx hash: {h}")
    return h.lower()


@router.post("/fetch", response_model=LabelFetchResponse, status_code=202)
async def enqueue_label_fetch(
    payload: LabelFetchRequest,
    db: RelationalDBDep,
    mq: MessageQueueDep,
    settings: SettingsDep,
) -> LabelFetchResponse:
    """
    Enqueue targeted ingestion work for the ingest worker.

    Writes one `label_tasks` row per address (when relevant) and LPUSHes a JSON
    payload onto `ingest:targeted_queue`. The `ingest targeted from-label-tasks`
    subcommand drains the queue.
    """
    queue_key = settings.ingest_targeted_queue
    redis_conn = getattr(mq, "redis", None)
    if redis_conn is None:
        raise HTTPException(status_code=503, detail="Message queue not available")

    task_ids: list[int] = []
    enqueued = 0

    if payload.mode == "addresses":
        if not payload.addresses:
            raise HTTPException(status_code=400, detail="addresses required")
        addrs = [_validate_address(a) for a in payload.addresses]
        for addr in addrs:
            result = await db.execute(
                """
                INSERT INTO label_tasks (entity_address, title, status, priority)
                VALUES (:address, :title, 'pending', 0)
                RETURNING id
                """,
                {"address": addr, "title": f"Fetch on-chain data for {addr}"},
            )
            task_id = result[0]["id"]
            task_ids.append(task_id)
            spec = {"mode": "addresses", "addrs": [addr]}
            await redis_conn.lpush(
                queue_key, json.dumps({"task_id": task_id, "spec": spec})
            )
            enqueued += 1

    elif payload.mode == "hashes":
        if not payload.hashes:
            raise HTTPException(status_code=400, detail="hashes required")
        hashes = [_validate_hash(h) for h in payload.hashes]
        spec = {"mode": "hashes", "hashes": hashes}
        await redis_conn.lpush(queue_key, json.dumps({"task_id": None, "spec": spec}))
        enqueued += 1

    elif payload.mode == "neighborhood":
        if not payload.seed:
            raise HTTPException(status_code=400, detail="seed required")
        seed = _validate_address(payload.seed)
        result = await db.execute(
            """
            INSERT INTO label_tasks (entity_address, title, status, priority)
            VALUES (:address, :title, 'pending', 0)
            RETURNING id
            """,
            {
                "address": seed,
                "title": f"Neighborhood fetch (hops={payload.hops}) for {seed}",
            },
        )
        task_id = result[0]["id"]
        task_ids.append(task_id)
        spec = {"mode": "neighborhood", "seed": seed, "hops": payload.hops}
        await redis_conn.lpush(
            queue_key, json.dumps({"task_id": task_id, "spec": spec})
        )
        enqueued += 1

    return LabelFetchResponse(task_ids=task_ids, queued=enqueued)


async def _create_label_task_core(
    task: LabelTaskCreate,
    db: RelationalDBDep,
) -> LabelTaskResponse:
    """Internal helper shared by the HTTP route and out-of-band callers (MCP)."""
    # Validate address format
    if not task.entity_address.startswith("0x") or len(task.entity_address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")

    address = task.entity_address.lower()

    # Insert task
    result = await db.execute(
        """
        INSERT INTO label_tasks (entity_address, title, description, priority, context)
        VALUES (:address, :title, :description, :priority, :context)
        RETURNING id, entity_address, status, priority, title, description,
                  assignee_id, created_at, updated_at
        """,
        {
            "address": address,
            "title": task.title,
            "description": task.description,
            "priority": task.priority,
            "context": task.context,
        },
    )

    if not result:
        raise HTTPException(status_code=500, detail="Failed to create task")

    row = result[0]
    return LabelTaskResponse(
        id=row["id"],
        entity_address=row["entity_address"],
        status=row["status"],
        priority=row["priority"],
        title=row["title"],
        description=row["description"],
        assignee_id=row["assignee_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.post("/tasks", response_model=LabelTaskResponse, status_code=201)
@limiter.limit(get_settings().rate_limit_labels)
async def create_label_task(
    request: Request,
    task: LabelTaskCreate,
    db: RelationalDBDep,
) -> LabelTaskResponse:
    """
    Create a new labeling task.

    Args:
        task: Task creation data

    Returns:
        Created task
    """
    return await _create_label_task_core(task, db)


@router.get("/tasks", response_model=list[LabelTaskResponse])
async def list_label_tasks(
    db: RelationalDBDep,
    status: str | None = Query(None, description="Filter by status"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[LabelTaskResponse]:
    """
    List labeling tasks.

    Args:
        status: Optional status filter
        limit: Maximum number of tasks to return
        offset: Number of tasks to skip

    Returns:
        List of tasks
    """
    if status is not None:
        query = """
            SELECT id, entity_address, status, priority, title, description,
                   assignee_id, created_at, updated_at
            FROM label_tasks
            WHERE status = :status
            ORDER BY priority DESC, created_at DESC
            LIMIT :limit OFFSET :offset
        """
        params: dict = {"status": status, "limit": limit, "offset": offset}
    else:
        query = """
            SELECT id, entity_address, status, priority, title, description,
                   assignee_id, created_at, updated_at
            FROM label_tasks
            ORDER BY priority DESC, created_at DESC
            LIMIT :limit OFFSET :offset
        """
        params = {"limit": limit, "offset": offset}

    result = await db.execute(query, params)

    return [
        LabelTaskResponse(
            id=row["id"],
            entity_address=row["entity_address"],
            status=row["status"],
            priority=row["priority"],
            title=row["title"],
            description=row["description"],
            assignee_id=row["assignee_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        for row in result
    ]


@router.get("/tasks/{task_id}", response_model=LabelTaskResponse)
async def get_label_task(
    task_id: int,
    db: RelationalDBDep,
) -> LabelTaskResponse:
    """
    Get a specific labeling task.

    Args:
        task_id: Task ID

    Returns:
        Task details
    """
    result = await db.execute(
        """
        SELECT id, entity_address, status, priority, title, description,
               assignee_id, created_at, updated_at
        FROM label_tasks
        WHERE id = :task_id
        """,
        {"task_id": task_id},
    )

    if not result:
        raise HTTPException(status_code=404, detail="Task not found")

    row = result[0]
    return LabelTaskResponse(
        id=row["id"],
        entity_address=row["entity_address"],
        status=row["status"],
        priority=row["priority"],
        title=row["title"],
        description=row["description"],
        assignee_id=row["assignee_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.post("/annotations", response_model=AnnotationResponse, status_code=201)
async def create_annotation(
    annotation: AnnotationCreate,
    db: RelationalDBDep,
) -> AnnotationResponse:
    """
    Submit an annotation for a labeling task.

    Args:
        annotation: Annotation data

    Returns:
        Created annotation
    """
    # Validate address format
    if (
        not annotation.entity_address.startswith("0x")
        or len(annotation.entity_address) != 42
    ):
        raise HTTPException(status_code=400, detail="Invalid address format")

    address = annotation.entity_address.lower()

    # Verify task exists
    task_result = await db.execute(
        "SELECT id FROM label_tasks WHERE id = :task_id",
        {"task_id": annotation.task_id},
    )
    if not task_result:
        raise HTTPException(status_code=404, detail="Task not found")

    # Insert annotation (user_id is nullable — populated once auth is wired)
    result = await db.execute(
        """
        INSERT INTO annotations (
            task_id, user_id, entity_address, entity_type,
            risk_level, labels, notes, evidence, confidence
        )
        VALUES (
            :task_id, NULL, :address, :entity_type,
            :risk_level, CAST(:labels AS JSON), :notes, CAST(:evidence AS JSON), :confidence
        )
        RETURNING id, task_id, user_id, entity_address, entity_type,
                  risk_level, labels, notes, confidence, created_at
        """,
        {
            "task_id": annotation.task_id,
            "address": address,
            "entity_type": (
                annotation.entity_type.value if annotation.entity_type else None
            ),
            "risk_level": annotation.risk_level.value,
            "labels": json.dumps(annotation.labels) if annotation.labels is not None else None,
            "notes": annotation.notes,
            "evidence": json.dumps(annotation.evidence) if annotation.evidence is not None else None,
            "confidence": annotation.confidence,
        },
    )

    if not result:
        raise HTTPException(status_code=500, detail="Failed to create annotation")

    # Update task status to completed
    await db.execute(
        """
        UPDATE label_tasks
        SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = :task_id
        """,
        {"task_id": annotation.task_id},
    )

    row = result[0]
    return AnnotationResponse(
        id=row["id"],
        task_id=row["task_id"],
        user_id=row["user_id"],
        entity_address=row["entity_address"],
        entity_type=row["entity_type"],
        risk_level=row["risk_level"],
        labels=row["labels"],
        notes=row["notes"],
        confidence=row["confidence"],
        created_at=row["created_at"],
    )


@router.get("/annotations/{entity_address}", response_model=list[AnnotationResponse])
async def get_entity_annotations(
    entity_address: str,
    db: RelationalDBDep,
    limit: int = Query(50, ge=1, le=100),
) -> list[AnnotationResponse]:
    """
    Get all annotations for an entity.

    Args:
        entity_address: Entity address
        limit: Maximum number of annotations to return

    Returns:
        List of annotations
    """
    # Validate address format
    if not entity_address.startswith("0x") or len(entity_address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")

    address = entity_address.lower()

    result = await db.execute(
        """
        SELECT id, task_id, user_id, entity_address, entity_type,
               risk_level, labels, notes, confidence, created_at
        FROM annotations
        WHERE entity_address = :address
        ORDER BY created_at DESC
        LIMIT :limit
        """,
        {"address": address, "limit": limit},
    )

    return [
        AnnotationResponse(
            id=row["id"],
            task_id=row["task_id"],
            user_id=row["user_id"],
            entity_address=row["entity_address"],
            entity_type=row["entity_type"],
            risk_level=row["risk_level"],
            labels=row["labels"],
            notes=row["notes"],
            confidence=row["confidence"],
            created_at=row["created_at"],
        )
        for row in result
    ]
