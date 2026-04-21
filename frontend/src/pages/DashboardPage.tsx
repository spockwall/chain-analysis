/**
 * Dashboard page — system health and quick stats.
 */
import { useHealth } from "../hooks/useHealth";
import { useGraphStats } from "../hooks/useGraphStats";
import { btnSecondary } from "@/constants";
const sectionLabel = "text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400";

const EXTERNAL_TOOLS: Array<{ name: string; url: string; description: string }> = [
    { name: "Dagster", url: "http://localhost:3000", description: "ETL orchestration" },
    { name: "Grafana", url: "http://localhost:3001", description: "Metrics dashboards" },
    { name: "Prometheus", url: "http://localhost:9090", description: "Metrics & targets" },
    { name: "Alertmanager", url: "http://localhost:9093", description: "Alert routing" },
    { name: "Neo4j Browser", url: "http://localhost:7474", description: "Graph queries" },
    { name: "MinIO Console", url: "http://localhost:9001", description: "Object storage" },
];

export function DashboardPage() {
    const { health, loading, error, lastChecked, refresh } = useHealth({
        refreshInterval: 30000,
    });
    const {
        stats,
        loading: statsLoading,
        refresh: refreshStats,
    } = useGraphStats({
        refreshInterval: 30000,
    });

    const overallHealthy = health?.status === "healthy";

    return (
        <div className="flex-1 min-h-0 overflow-auto bg-[var(--bg-primary)]">
            <div className="max-w-[860px] mx-auto px-6 py-8">
                {/* Page header */}
                <div className="mb-7">
                    <p className={`${sectionLabel} mb-1`}>System</p>
                    <h1 className="text-2xl font-bold tracking-tight text-gray-900 m-0">Dashboard</h1>
                </div>

                {/* Overall status banner */}
                {health && (
                    <div
                        className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border mb-6 ${
                            overallHealthy
                                ? "border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.06)]"
                                : "border-[rgba(234,179,8,0.3)] bg-[rgba(234,179,8,0.06)]"
                        }`}
                    >
                        <span
                            className={`w-2 h-2 rounded-full shrink-0 ${overallHealthy ? "bg-green-500" : "bg-yellow-500"}`}
                        />
                        <span className="text-[0.85rem] font-semibold text-gray-900">
                            {overallHealthy ? "All Systems Operational" : "Degraded — some services unhealthy"}
                        </span>
                    </div>
                )}

                {/* Graph quick stats */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                    <div className="flex justify-between items-center mb-4">
                        <p className={sectionLabel}>Graph Statistics</p>
                        <button onClick={refreshStats} disabled={statsLoading} className={btnSecondary}>
                            {statsLoading ? "Loading…" : "Refresh"}
                        </button>
                    </div>
                    {stats ? (
                        <>
                            <div className="grid grid-cols-4 gap-3">
                                <StatItem value={stats.node_count.toLocaleString()} label="Total Entities" />
                                <StatItem
                                    value={(stats.transaction_count ?? 0).toLocaleString()}
                                    label="Transactions"
                                />
                                <StatItem
                                    value={(
                                        (stats.risk_levels["high"] ?? 0) + (stats.risk_levels["critical"] ?? 0)
                                    ).toLocaleString()}
                                    label="High Risk"
                                />
                                <StatItem value={String(Object.keys(stats.entity_types).length)} label="Entity Types" />
                            </div>
                            {Object.keys(stats.entity_types).length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-3.5">
                                    {Object.entries(stats.entity_types).map(([type, count]) => (
                                        <span
                                            key={type}
                                            className="px-2 py-0.5 bg-gray-50 border border-gray-200 rounded text-[0.7rem] text-gray-600"
                                        >
                                            {type}: {count}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        !statsLoading && (
                            <p className="text-[0.78rem] text-gray-400">No graph data — run the ETL pipeline first.</p>
                        )
                    )}
                </div>

                {/* Observability & orchestration tools */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                    <p className={`${sectionLabel} mb-4`}>Observability & Orchestration</p>
                    <div className="grid grid-cols-2 gap-2">
                        {EXTERNAL_TOOLS.map((tool) => (
                            <a
                                key={tool.name}
                                href={tool.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2.5 px-3.5 py-2.5 border border-gray-200 rounded-lg bg-gray-50 hover:bg-white hover:border-gray-300 transition-colors no-underline"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-[0.8rem] font-semibold text-gray-900">{tool.name}</div>
                                    <div className="text-[0.68rem] text-gray-400 truncate">{tool.description}</div>
                                </div>
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="text-gray-400 shrink-0"
                                >
                                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                </svg>
                            </a>
                        ))}
                    </div>
                </div>

                {/* Service health */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                    <div className="flex justify-between items-center mb-4">
                        <p className={sectionLabel}>Service Health</p>
                        <div className="flex items-center gap-2.5">
                            {lastChecked && (
                                <span className="text-[0.68rem] text-gray-400">
                                    Last checked {lastChecked.toLocaleTimeString()}
                                </span>
                            )}
                            <button onClick={refresh} disabled={loading} className={btnSecondary}>
                                {loading ? "Checking…" : "Refresh"}
                            </button>
                        </div>
                    </div>

                    {error && <p className="text-[0.78rem] text-red-500 mb-2.5">{error}</p>}

                    {health ? (
                        <div className="grid grid-cols-2 gap-2">
                            {Object.entries(health.services).map(([service, healthy]) => (
                                <div
                                    key={service}
                                    className="flex items-center gap-2.5 px-3.5 py-2.5 border border-gray-200 rounded-lg bg-gray-50"
                                >
                                    <span
                                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${healthy ? "bg-green-500" : "bg-red-500"}`}
                                    />
                                    <span className="flex-1 text-[0.8rem] text-gray-900 capitalize">{service}</span>
                                    <span
                                        className={`text-[0.65rem] font-semibold uppercase tracking-[0.04em] ${healthy ? "text-green-700" : "text-red-700"}`}
                                    >
                                        {healthy ? "OK" : "Down"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        !loading && <p className="text-[0.78rem] text-gray-400">No health data yet.</p>
                    )}
                </div>
            </div>
        </div>
    );
}

function StatItem({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex flex-col gap-1 p-3 bg-gray-50 rounded-lg border border-gray-100">
            <div className="text-[1.4rem] font-bold text-gray-900 tracking-tight leading-none">{value}</div>
            <div className="text-[0.7rem] text-gray-400">{label}</div>
        </div>
    );
}
