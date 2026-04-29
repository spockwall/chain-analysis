"""Health check endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.deps import GraphDBDep, MessageQueueDep, RelationalDBDep

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    services: dict[str, bool]


class ServiceStatus(BaseModel):
    """Individual service status."""

    healthy: bool
    message: str | None = None


class HealthStatusResponse(BaseModel):
    """Simple health status response for probes."""

    status: str


@router.get("/health", response_model=HealthResponse)
async def health_check(
    graph_db: GraphDBDep,
    relational_db: RelationalDBDep,
    message_queue: MessageQueueDep,
) -> HealthResponse:
    """
    Check the health of all services.

    Returns the overall status and individual service health.
    """
    services = {}

    # Check Neo4j
    try:
        await graph_db.execute_query("RETURN 1 AS ok")
        services["neo4j"] = True
    except Exception:
        services["neo4j"] = False

    # Check PostgreSQL
    try:
        healthy = await relational_db.health_check()
        services["postgresql"] = healthy
    except Exception:
        services["postgresql"] = False

    # Check Redis
    try:
        healthy = await message_queue.health_check()
        services["redis"] = healthy
    except Exception:
        services["redis"] = False

    # Overall status
    all_healthy = all(services.values())
    status = "healthy" if all_healthy else "degraded"

    return HealthResponse(status=status, services=services)


@router.get("/health/live", response_model=HealthStatusResponse)
async def liveness_probe() -> HealthStatusResponse:
    """
    Kubernetes liveness probe.

    Simply returns OK to indicate the service is running.
    """
    return HealthStatusResponse(status="ok")


@router.get("/health/ready", response_model=HealthStatusResponse)
async def readiness_probe(
    graph_db: GraphDBDep,
    relational_db: RelationalDBDep,
) -> HealthStatusResponse:
    """
    Kubernetes readiness probe.

    Checks if critical services (Neo4j, PostgreSQL) are available.
    """
    try:
        await graph_db.execute_query("RETURN 1 AS ok")
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Neo4j not ready: {e}")

    try:
        healthy = await relational_db.health_check()
        if not healthy:
            raise HTTPException(status_code=503, detail="PostgreSQL not ready")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"PostgreSQL error: {e}")

    return HealthStatusResponse(status="ready")
