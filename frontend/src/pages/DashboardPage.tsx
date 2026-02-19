/**
 * Dashboard page — system health and quick stats.
 * Rewritten to use Oravia design system, moved from components/.
 */
import { useHealth } from "../hooks/useHealth";

interface DashboardPageProps {
    onClose: () => void;
}

export function DashboardPage({ onClose }: DashboardPageProps) {
    const { health, loading, error, lastChecked, refresh } = useHealth({
        refreshInterval: 30000,
    });

    const overallHealthy = health?.status === "healthy";

    return (
        /* Modal overlay */
        <div
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 60,
                background: "rgba(15,23,42,0.4)",
                backdropFilter: "blur(4px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "20px",
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className="card"
                style={{
                    width: "100%",
                    maxWidth: 560,
                    maxHeight: "80vh",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
            >
                {/* Header */}
                <div className="panel-header">
                    <div>
                        <p className="panel-section-label" style={{ marginBottom: 4 }}>
                            System
                        </p>
                        <h2 className="heading-md">Dashboard.</h2>
                    </div>
                    <button className="btn-icon" onClick={onClose} aria-label="Close dashboard">
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Scrollable body */}
                <div className="panel-body">
                    {/* Overall status banner */}
                    {health && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "10px 14px",
                                borderRadius: "var(--radius-md)",
                                border: "1px solid",
                                borderColor: overallHealthy ? "rgba(34,197,94,0.3)" : "rgba(234,179,8,0.3)",
                                background: overallHealthy ? "rgba(34,197,94,0.06)" : "rgba(234,179,8,0.06)",
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
                            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                                {overallHealthy ? "All Systems Operational" : "Degraded — some services unhealthy"}
                            </span>
                        </div>
                    )}

                    <hr className="divider" />

                    {/* Service health */}
                    <div>
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: 10,
                            }}
                        >
                            <p className="panel-section-label" style={{ marginBottom: 0 }}>
                                Service Health
                            </p>
                            <button
                                onClick={refresh}
                                disabled={loading}
                                className="btn btn-secondary"
                                style={{ padding: "4px 10px", fontSize: "0.72rem" }}
                            >
                                {loading ? "Checking…" : "Refresh"}
                            </button>
                        </div>

                        {error && (
                            <div
                                className="toast toast-error"
                                style={{ position: "static", transform: "none", marginBottom: 10, animation: "none" }}
                            >
                                {error}
                            </div>
                        )}

                        {health ? (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                {Object.entries(health.services).map(([service, healthy]) => (
                                    <div
                                        key={service}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "9px 12px",
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
                                                fontSize: "0.78rem",
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

                        {lastChecked && (
                            <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginTop: 8 }}>
                                Last checked {lastChecked.toLocaleTimeString()}
                            </p>
                        )}
                    </div>

                    <hr className="divider" />

                    {/* Quick stats */}
                    <div>
                        <p className="panel-section-label">Quick Stats</p>
                        <div className="stat-grid">
                            {[
                                { label: "Total Entities", value: "—" },
                                { label: "High Risk", value: "—" },
                                { label: "Pending Labels", value: "—" },
                            ].map(({ label, value }) => (
                                <div key={label} className="stat-item">
                                    <div className="stat-value" style={{ fontSize: "1.6rem" }}>
                                        {value}
                                    </div>
                                    <div className="stat-label">{label}</div>
                                </div>
                            ))}
                        </div>
                        <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 10 }}>
                            Connect to backend to see live statistics.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
