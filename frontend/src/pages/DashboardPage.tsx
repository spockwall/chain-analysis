/**
 * Dashboard page — system health and quick stats.
 */
import { useHealth } from "../hooks/useHealth";
import { useGraphStats } from "../hooks/useGraphStats";

export function DashboardPage() {
    const { health, loading, error, lastChecked, refresh } = useHealth({
        refreshInterval: 30000,
    });
    const { stats, loading: statsLoading, refresh: refreshStats } = useGraphStats({
        refreshInterval: 30000,
    });

    const overallHealthy = health?.status === "healthy";

    return (
        <div className="page-content">
            <div className="page-padded">
                {/* Page header */}
                <div style={{ marginBottom: 28 }}>
                    <p className="panel-section-label" style={{ marginBottom: 4 }}>System</p>
                    <h1 className="heading-md" style={{ fontSize: "1.5rem", margin: 0 }}>Dashboard</h1>
                </div>

                {/* Overall status banner */}
                {health && (
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "12px 16px",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid",
                            borderColor: overallHealthy ? "rgba(34,197,94,0.3)" : "rgba(234,179,8,0.3)",
                            background: overallHealthy ? "rgba(34,197,94,0.06)" : "rgba(234,179,8,0.06)",
                            marginBottom: 24,
                        }}
                    >
                        <span
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                flexShrink: 0,
                                background: overallHealthy ? "var(--risk-low)" : "var(--risk-medium)",
                            }}
                        />
                        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                            {overallHealthy ? "All Systems Operational" : "Degraded — some services unhealthy"}
                        </span>
                    </div>
                )}

                {/* Graph quick stats */}
                <div className="card" style={{ marginBottom: 20, padding: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <p className="panel-section-label" style={{ marginBottom: 0 }}>Graph Statistics</p>
                        <button
                            onClick={refreshStats}
                            disabled={statsLoading}
                            className="btn btn-secondary"
                            style={{ padding: "4px 10px", fontSize: "0.72rem" }}
                        >
                            {statsLoading ? "Loading…" : "Refresh"}
                        </button>
                    </div>
                    {stats ? (
                        <>
                            <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                                <div className="stat-item">
                                    <div className="stat-value">{stats.node_count.toLocaleString()}</div>
                                    <div className="stat-label">Total Entities</div>
                                </div>
                                <div className="stat-item">
                                    <div className="stat-value">{(stats.transaction_count ?? 0).toLocaleString()}</div>
                                    <div className="stat-label">Transactions</div>
                                </div>
                                <div className="stat-item">
                                    <div className="stat-value">
                                        {((stats.risk_levels["high"] ?? 0) + (stats.risk_levels["critical"] ?? 0)).toLocaleString()}
                                    </div>
                                    <div className="stat-label">High Risk</div>
                                </div>
                                <div className="stat-item">
                                    <div className="stat-value">{Object.keys(stats.entity_types).length}</div>
                                    <div className="stat-label">Entity Types</div>
                                </div>
                            </div>
                            {Object.keys(stats.entity_types).length > 0 && (
                                <div className="tag-list" style={{ marginTop: 14 }}>
                                    {Object.entries(stats.entity_types).map(([type, count]) => (
                                        <span key={type} className="tag">
                                            {type}: {count}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        !statsLoading && (
                            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                                No graph data — run the ETL pipeline first.
                            </p>
                        )
                    )}
                </div>

                {/* Service health */}
                <div className="card" style={{ padding: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <p className="panel-section-label" style={{ marginBottom: 0 }}>Service Health</p>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            {lastChecked && (
                                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                                    Last checked {lastChecked.toLocaleTimeString()}
                                </span>
                            )}
                            <button
                                onClick={refresh}
                                disabled={loading}
                                className="btn btn-secondary"
                                style={{ padding: "4px 10px", fontSize: "0.72rem" }}
                            >
                                {loading ? "Checking…" : "Refresh"}
                            </button>
                        </div>
                    </div>

                    {error && (
                        <p style={{ fontSize: "0.78rem", color: "var(--risk-critical)", marginBottom: 10 }}>{error}</p>
                    )}

                    {health ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                            {Object.entries(health.services).map(([service, healthy]) => (
                                <div
                                    key={service}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 10,
                                        padding: "10px 14px",
                                        border: "1px solid var(--border-light)",
                                        borderRadius: "var(--radius-md)",
                                        background: "var(--bg-primary)",
                                    }}
                                >
                                    <span
                                        style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: "50%",
                                            flexShrink: 0,
                                            background: healthy ? "var(--risk-low)" : "var(--risk-critical)",
                                        }}
                                    />
                                    <span
                                        style={{
                                            flex: 1,
                                            fontSize: "0.8rem",
                                            color: "var(--text-primary)",
                                            textTransform: "capitalize",
                                        }}
                                    >
                                        {service}
                                    </span>
                                    <span
                                        style={{
                                            fontSize: "0.65rem",
                                            fontWeight: 600,
                                            textTransform: "uppercase",
                                            letterSpacing: "0.04em",
                                            color: healthy ? "#15803d" : "#b91c1c",
                                        }}
                                    >
                                        {healthy ? "OK" : "Down"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        !loading && (
                            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>No health data yet.</p>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}
