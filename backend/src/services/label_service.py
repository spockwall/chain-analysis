"""
Label service for managing labeling workflows.
"""

from datetime import datetime
from typing import Any

from core.ports import GraphDatabase, RelationalDatabase
from libs import logger


class LabelService:
    """Service for labeling workflow business logic."""

    def __init__(
        self,
        graph_db: GraphDatabase,
        relational_db: RelationalDatabase,
    ) -> None:
        self._graph_db = graph_db
        self._relational_db = relational_db

    async def create_task_with_context(
        self,
        entity_address: str,
        title: str | None = None,
        description: str | None = None,
        priority: int = 0,
        include_neighbors: bool = True,
    ) -> dict[str, Any]:
        """
        Create a labeling task with graph context.

        Args:
            entity_address: Address to label
            title: Task title
            description: Task description
            priority: Task priority
            include_neighbors: Whether to include 1-hop neighborhood

        Returns:
            Created task with context
        """
        address = entity_address.lower()

        # Get entity data
        node = await self._graph_db.get_node(address)

        # Get neighborhood if requested
        context: dict[str, Any] = {}
        if include_neighbors:
            subgraph = await self._graph_db.get_neighbors(
                address=address,
                depth=1,
                direction="both",
                limit=50,
            )
            context["neighbors"] = {
                "nodes": [
                    {"address": n.address, "labels": n.labels}
                    for n in subgraph.nodes
                ],
                "edges": [
                    {
                        "source": e.source,
                        "target": e.target,
                        "type": e.edge_type,
                        "value": e.properties.get("value"),
                    }
                    for e in subgraph.edges
                ],
            }

        # Check for existing annotations
        existing = await self._relational_db.execute(
            """
            SELECT entity_type, risk_level, labels, notes
            FROM annotations
            WHERE entity_address = :address
            ORDER BY created_at DESC
            LIMIT 5
            """,
            {"address": address},
        )
        if existing:
            context["previous_annotations"] = existing

        # Check known labels
        known = await self._relational_db.execute(
            """
            SELECT name, entity_type, category, risk_level, source
            FROM known_labels
            WHERE address = :address
            """,
            {"address": address},
        )
        if known:
            context["known_labels"] = known

        # Create task
        result = await self._relational_db.execute(
            """
            INSERT INTO label_tasks (entity_address, title, description, priority, context)
            VALUES (:address, :title, :description, :priority, :context)
            RETURNING id, entity_address, status, priority, title, description,
                      assignee_id, created_at, updated_at
            """,
            {
                "address": address,
                "title": title or f"Label entity {address[:10]}...",
                "description": description,
                "priority": priority,
                "context": context,
            },
        )

        if not result:
            raise RuntimeError("Failed to create task")

        return result[0]

    async def get_next_task(
        self,
        user_id: int,
        category: str | None = None,
    ) -> dict[str, Any] | None:
        """
        Get the next pending task for a user.

        Assigns the task to the user and returns it.

        Args:
            user_id: ID of the user
            category: Optional category filter

        Returns:
            Next task or None if no tasks available
        """
        # Find highest priority pending task
        query = """
            SELECT id, entity_address, status, priority, title, description,
                   context, created_at
            FROM label_tasks
            WHERE status = 'pending'
            AND assignee_id IS NULL
            ORDER BY priority DESC, created_at ASC
            LIMIT 1
        """

        result = await self._relational_db.execute(query)

        if not result:
            return None

        task = result[0]

        # Assign to user
        await self._relational_db.execute(
            """
            UPDATE label_tasks
            SET assignee_id = :user_id,
                status = 'in_progress',
                assigned_at = NOW(),
                updated_at = NOW()
            WHERE id = :task_id
            """,
            {"user_id": user_id, "task_id": task["id"]},
        )

        task["assignee_id"] = user_id
        task["status"] = "in_progress"

        return task

    async def submit_annotation_and_update_graph(
        self,
        task_id: int,
        user_id: int | None,
        entity_address: str,
        entity_type: str | None,
        risk_level: str,
        labels: list[str] | None = None,
        notes: str | None = None,
        confidence: float | None = None,
    ) -> dict[str, Any]:
        """
        Submit an annotation and update the graph database.

        Args:
            task_id: Task ID
            user_id: User ID (nullable)
            entity_address: Entity address
            entity_type: Entity type classification
            risk_level: Risk level
            labels: Additional labels
            notes: Analyst notes
            confidence: Confidence score

        Returns:
            Created annotation
        """
        address = entity_address.lower()

        # Create annotation in PostgreSQL
        result = await self._relational_db.execute(
            """
            INSERT INTO annotations (
                task_id, user_id, entity_address, entity_type,
                risk_level, labels, notes, confidence
            )
            VALUES (
                :task_id, :user_id, :address, :entity_type,
                :risk_level, :labels, :notes, :confidence
            )
            RETURNING id, task_id, user_id, entity_address, entity_type,
                      risk_level, labels, notes, confidence, created_at
            """,
            {
                "task_id": task_id,
                "user_id": user_id,
                "address": address,
                "entity_type": entity_type,
                "risk_level": risk_level,
                "labels": labels,
                "notes": notes,
                "confidence": confidence,
            },
        )

        if not result:
            raise RuntimeError("Failed to create annotation")

        annotation = result[0]

        # Update task status
        await self._relational_db.execute(
            """
            UPDATE label_tasks
            SET status = 'completed',
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = :task_id
            """,
            {"task_id": task_id},
        )

        # Update Neo4j node with new labels
        properties: dict[str, Any] = {
            "risk_level": risk_level,
            "labeled_at": datetime.utcnow().isoformat(),
            "labeled_by": user_id,
        }
        if entity_type:
            properties["entity_type"] = entity_type

        await self._graph_db.execute_query(
            """
            MERGE (e:Entity {address: $address})
            SET e += $properties
            """,
            {"address": address, "properties": properties},
        )

        # Add node labels if entity type specified
        if entity_type:
            try:
                await self._graph_db.execute_query(
                    """
                    MATCH (e:Entity {address: $address})
                    SET e:$label
                    """.replace("$label", entity_type),
                    {"address": address},
                )
            except Exception as e:
                logger.warning("failed_to_add_label", error=str(e))

        return annotation

    async def get_labeling_stats(self) -> dict[str, Any]:
        """
        Get labeling workflow statistics.

        Returns:
            Statistics about labeling progress
        """
        # Task stats
        task_stats = await self._relational_db.execute(
            """
            SELECT
                status,
                COUNT(*) as count
            FROM label_tasks
            GROUP BY status
            """
        )

        # Annotation stats by risk level
        risk_stats = await self._relational_db.execute(
            """
            SELECT
                risk_level,
                COUNT(*) as count
            FROM annotations
            GROUP BY risk_level
            """
        )

        # Top annotators (users with most annotations)
        top_annotators = await self._relational_db.execute(
            """
            SELECT
                u.username,
                COUNT(a.id) as annotation_count
            FROM users u
            JOIN annotations a ON u.id = a.user_id
            GROUP BY u.id, u.username
            ORDER BY annotation_count DESC
            LIMIT 10
            """
        )

        # Recent activity
        recent_count = await self._relational_db.execute(
            """
            SELECT COUNT(*) as count
            FROM annotations
            WHERE created_at > NOW() - INTERVAL '24 hours'
            """
        )

        return {
            "tasks_by_status": {row["status"]: row["count"] for row in task_stats},
            "annotations_by_risk": {row["risk_level"]: row["count"] for row in risk_stats},
            "top_annotators": top_annotators,
            "annotations_last_24h": recent_count[0]["count"] if recent_count else 0,
        }
