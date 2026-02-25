"""Labeling workflow API endpoints."""

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select, text

from api.deps import RelationalDBDep
from api.models.entity import (
    AnnotationCreate,
    AnnotationResponse,
    LabelTaskCreate,
    LabelTaskResponse,
)
from db.models import Annotation, LabelTask, TaskStatus

router = APIRouter(prefix="/labels", tags=["labels"])


@router.post("/tasks", response_model=LabelTaskResponse, status_code=201)
async def create_label_task(
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
    query = """
        SELECT id, entity_address, status, priority, title, description,
               assignee_id, created_at, updated_at
        FROM label_tasks
        WHERE (:status IS NULL OR status = :status)
        ORDER BY priority DESC, created_at DESC
        LIMIT :limit OFFSET :offset
    """

    result = await db.execute(
        query,
        {"status": status, "limit": limit, "offset": offset},
    )

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
            :risk_level, :labels, :notes, :evidence, :confidence
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
            "labels": annotation.labels,
            "notes": annotation.notes,
            "evidence": annotation.evidence,
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
