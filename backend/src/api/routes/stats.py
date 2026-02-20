"""Graph statistics API endpoints for ETL pipeline testing."""

from fastapi import APIRouter
from pydantic import BaseModel

from api.deps import GraphDBDep

router = APIRouter(prefix="/stats", tags=["stats"])


class GraphStatsResponse(BaseModel):
    """Response model for graph statistics."""

    node_count: int
    transaction_count: int
    edge_count: int  # counts SENT + RECEIVED relationships
    entity_types: dict[str, int]
    risk_levels: dict[str, int]


@router.get("", response_model=GraphStatsResponse)
async def get_graph_stats(graph_db: GraphDBDep) -> GraphStatsResponse:
    """
    Get graph statistics from Neo4j.

    Returns counts of nodes, transaction nodes, edges, and breakdowns by
    entity type and risk level.
    Useful for verifying ETL pipeline has ingested data correctly.
    """
    # Count total entity nodes
    node_count_query = "MATCH (n:Entity) RETURN count(n) AS count"
    node_result = await graph_db.execute_query(node_count_query)
    node_count = node_result[0]["count"] if node_result else 0

    # Count transaction nodes
    tx_count_query = "MATCH (t:Transaction) RETURN count(t) AS count"
    tx_result = await graph_db.execute_query(tx_count_query)
    transaction_count = tx_result[0]["count"] if tx_result else 0

    # Count total relationships (SENT + RECEIVED)
    edge_count_query = "MATCH ()-[r]->() RETURN count(r) AS count"
    edge_result = await graph_db.execute_query(edge_count_query)
    edge_count = edge_result[0]["count"] if edge_result else 0

    # Count by entity type (from labels)
    entity_types_query = """
    MATCH (n:Entity)
    UNWIND labels(n) AS label
    WITH label
    WHERE label <> 'Entity'
    RETURN label AS entity_type, count(*) AS count
    ORDER BY count DESC
    """
    entity_types_result = await graph_db.execute_query(entity_types_query)
    entity_types = {row["entity_type"]: row["count"] for row in entity_types_result}

    # Count by risk level
    risk_levels_query = """
    MATCH (n:Entity)
    WHERE n.risk_level IS NOT NULL
    RETURN n.risk_level AS risk_level, count(*) AS count
    ORDER BY count DESC
    """
    risk_levels_result = await graph_db.execute_query(risk_levels_query)
    risk_levels = {row["risk_level"]: row["count"] for row in risk_levels_result}

    return GraphStatsResponse(
        node_count=node_count,
        transaction_count=transaction_count,
        edge_count=edge_count,
        entity_types=entity_types,
        risk_levels=risk_levels,
    )
