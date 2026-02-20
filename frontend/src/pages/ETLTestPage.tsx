/**
 * ETL Test Page — test backend ETL pipeline functionality.
 * Covers: graph stats, entity lookup, node upsert/update/delete, edge upsert/delete.
 */
import { useState } from "react";
import { useHealth } from "../hooks/useHealth";
import { useGraphStats } from "../hooks/useGraphStats";
import {
    fetchEntity,
    fetchNeighbors,
    upsertEntity,
    updateEntity,
    deleteEntity,
    upsertEdge,
    deleteEdge,
    formatAddress,
} from "../api/client";
import type { EntityResponse, EntityType, NeighborsResponse, RiskLevel, TransactionResponse } from "../types";

interface ETLTestPageProps {
    onClose: () => void;
}

// ── tiny helpers ──────────────────────────────────────────────────────────────

const ENTITY_TYPES: EntityType[] = [
    "EOA",
    "Contract",
    "Mixer",
    "LendingPool",
    "Bridge",
    "DEX",
    "CEXHotWallet",
    "Application",
    "Unknown",
];
const RISK_LEVELS: RiskLevel[] = ["unknown", "low", "medium", "high", "critical"];

function isValidAddress(addr: string) {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function InlineError({ msg }: { msg: string | null }) {
    if (!msg) return null;
    return (
        <div
            className="toast toast-error"
            style={{ position: "static", transform: "none", marginTop: 8, animation: "none" }}
        >
            {msg}
        </div>
    );
}

function InlineSuccess({ msg }: { msg: string | null }) {
    if (!msg) return null;
    return (
        <div
            style={{
                marginTop: 8,
                padding: "8px 14px",
                borderRadius: "var(--radius-full)",
                background: "rgba(34,197,94,0.08)",
                border: "1px solid rgba(34,197,94,0.25)",
                fontSize: "0.78rem",
                fontWeight: 500,
                color: "#15803d",
            }}
        >
            {msg}
        </div>
    );
}

// ── main component ────────────────────────────────────────────────────────────

export function ETLTestPage({ onClose }: ETLTestPageProps) {
    const { health } = useHealth({ refreshInterval: 30000 });
    const {
        stats,
        loading: statsLoading,
        error: statsError,
        refresh: refreshStats,
    } = useGraphStats({ refreshInterval: 10000 });

    // ── Lookup state ───────────────────────────────────────────────────────────
    const [searchAddress, setSearchAddress] = useState("");
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [entityResult, setEntityResult] = useState<EntityResponse | null>(null);
    const [neighborsResult, setNeighborsResult] = useState<NeighborsResponse | null>(null);

    // ── Node upsert state ──────────────────────────────────────────────────────
    const [upsertAddr, setUpsertAddr] = useState("");
    const [upsertType, setUpsertType] = useState<EntityType>("EOA");
    const [upsertRisk, setUpsertRisk] = useState<RiskLevel>("unknown");
    const [upsertName, setUpsertName] = useState("");
    const [upsertMode, setUpsertMode] = useState<"put" | "patch">("put");
    const [upsertLoading, setUpsertLoading] = useState(false);
    const [upsertError, setUpsertError] = useState<string | null>(null);
    const [upsertSuccess, setUpsertSuccess] = useState<string | null>(null);
    const [upsertResult, setUpsertResult] = useState<EntityResponse | null>(null);

    // ── Node delete state ──────────────────────────────────────────────────────
    const [deleteAddr, setDeleteAddr] = useState("");
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);

    // ── Transaction upsert state ───────────────────────────────────────────────
    const [txHash, setTxHash] = useState("");
    const [txFrom, setTxFrom] = useState("");
    const [txTo, setTxTo] = useState("");
    const [txValue, setTxValue] = useState("");
    const [txBlock, setTxBlock] = useState("");
    const [txLoading, setTxLoading] = useState(false);
    const [txError, setTxError] = useState<string | null>(null);
    const [txSuccess, setTxSuccess] = useState<string | null>(null);
    const [txResult, setTxResult] = useState<TransactionResponse | null>(null);

    // ── Edge upsert state (legacy, kept for backward compat) ──────────────────
    const [edgeSrc, setEdgeSrc] = useState("");
    const [edgeTgt, setEdgeTgt] = useState("");
    const [edgeType, setEdgeType] = useState("TRANSFER");
    const [edgeValue, setEdgeValue] = useState("");
    const [edgeTxHash, setEdgeTxHash] = useState("");
    const [edgeLoading, setEdgeLoading] = useState(false);
    const [edgeError, setEdgeError] = useState<string | null>(null);
    const [edgeSuccess, setEdgeSuccess] = useState<string | null>(null);

    // ── Edge delete state ──────────────────────────────────────────────────────
    const [delEdgeSrc, setDelEdgeSrc] = useState("");
    const [delEdgeTgt, setDelEdgeTgt] = useState("");
    const [delEdgeType, setDelEdgeType] = useState("TRANSFER");
    const [delEdgeLoading, setDelEdgeLoading] = useState(false);
    const [delEdgeError, setDelEdgeError] = useState<string | null>(null);
    const [delEdgeSuccess, setDelEdgeSuccess] = useState<string | null>(null);

    const overallHealthy = health?.status === "healthy";

    // ── handlers ──────────────────────────────────────────────────────────────

    const handleSearch = async () => {
        const addr = searchAddress.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            setSearchError("Must be 0x followed by 40 hex characters.");
            return;
        }
        setSearchLoading(true);
        setSearchError(null);
        setEntityResult(null);
        setNeighborsResult(null);
        try {
            const [entity, neighbors] = await Promise.all([
                fetchEntity(addr),
                fetchNeighbors(addr, { depth: 1, limit: 20 }),
            ]);
            setEntityResult(entity);
            setNeighborsResult(neighbors);
        } catch (err) {
            setSearchError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setSearchLoading(false);
        }
    };

    const handleTxUpsert = async () => {
        const from = txFrom.trim().toLowerCase();
        const to = txTo.trim().toLowerCase();
        const hash = txHash.trim();
        if (!hash) {
            setTxError("Transaction hash is required.");
            return;
        }
        if (!isValidAddress(from)) {
            setTxError("Invalid from address.");
            return;
        }
        if (!isValidAddress(to)) {
            setTxError("Invalid to address.");
            return;
        }
        setTxLoading(true);
        setTxError(null);
        setTxSuccess(null);
        setTxResult(null);
        try {
            // Use the legacy edge upsert endpoint to proxy a transaction node creation
            // until a dedicated /transactions PUT endpoint is added to the backend.
            await upsertEdge(from, to, {
                source: from,
                target: to,
                edge_type: "TRANSFER",
                value: txValue || undefined,
                tx_hash: hash,
                block_number: txBlock ? parseInt(txBlock, 10) : undefined,
            });
            setTxResult({ hash, from_address: from, to_address: to, value: txValue || null, block_number: txBlock ? parseInt(txBlock, 10) : null, properties: {} });
            setTxSuccess(`Transaction upserted: ${hash.slice(0, 12)}…`);
            refreshStats();
        } catch (err) {
            setTxError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setTxLoading(false);
        }
    };

    const handleNodeUpsert = async () => {
        const addr = upsertAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            setUpsertError("Invalid address format.");
            return;
        }
        setUpsertLoading(true);
        setUpsertError(null);
        setUpsertSuccess(null);
        setUpsertResult(null);
        try {
            const body = {
                address: addr,
                entity_type: upsertType,
                risk_level: upsertRisk,
                name: upsertName || undefined,
            };
            const result = upsertMode === "put" ? await upsertEntity(addr, body) : await updateEntity(addr, body);
            setUpsertResult(result);
            setUpsertSuccess(`${upsertMode === "put" ? "Upserted" : "Updated"}: ${formatAddress(addr)}`);
            refreshStats();
        } catch (err) {
            setUpsertError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setUpsertLoading(false);
        }
    };

    const handleNodeDelete = async () => {
        const addr = deleteAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            setDeleteError("Invalid address format.");
            return;
        }
        setDeleteLoading(true);
        setDeleteError(null);
        setDeleteSuccess(null);
        try {
            await deleteEntity(addr);
            setDeleteSuccess(`Deleted: ${formatAddress(addr)}`);
            setDeleteAddr("");
            refreshStats();
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setDeleteLoading(false);
        }
    };

    const handleEdgeUpsert = async () => {
        const src = edgeSrc.trim().toLowerCase();
        const tgt = edgeTgt.trim().toLowerCase();
        if (!isValidAddress(src)) {
            setEdgeError("Invalid source address.");
            return;
        }
        if (!isValidAddress(tgt)) {
            setEdgeError("Invalid target address.");
            return;
        }
        if (src === tgt) {
            setEdgeError("Source and target must differ.");
            return;
        }
        setEdgeLoading(true);
        setEdgeError(null);
        setEdgeSuccess(null);
        try {
            await upsertEdge(src, tgt, {
                source: src,
                target: tgt,
                edge_type: edgeType || "TRANSFER",
                value: edgeValue || undefined,
                tx_hash: edgeTxHash || undefined,
            });
            setEdgeSuccess(`Edge upserted: ${formatAddress(src)} → ${formatAddress(tgt)}`);
            refreshStats();
        } catch (err) {
            setEdgeError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setEdgeLoading(false);
        }
    };

    const handleEdgeDelete = async () => {
        const src = delEdgeSrc.trim().toLowerCase();
        const tgt = delEdgeTgt.trim().toLowerCase();
        if (!isValidAddress(src)) {
            setDelEdgeError("Invalid source address.");
            return;
        }
        if (!isValidAddress(tgt)) {
            setDelEdgeError("Invalid target address.");
            return;
        }
        setDelEdgeLoading(true);
        setDelEdgeError(null);
        setDelEdgeSuccess(null);
        try {
            await deleteEdge(src, tgt, delEdgeType || "TRANSFER");
            setDelEdgeSuccess(`Deleted edge: ${formatAddress(src)} → ${formatAddress(tgt)}`);
            refreshStats();
        } catch (err) {
            setDelEdgeError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setDelEdgeLoading(false);
        }
    };

    // ── shared style snippets ─────────────────────────────────────────────────

    const inputStyle: React.CSSProperties = {
        flex: 1,
        padding: "7px 10px",
        border: "1px solid var(--border-light)",
        borderRadius: "var(--radius-md)",
        fontSize: "0.78rem",
        fontFamily: "inherit",
        background: "var(--bg-card)",
        color: "var(--text-primary)",
    };

    const selectStyle: React.CSSProperties = {
        ...inputStyle,
        flex: "none",
        cursor: "pointer",
    };

    // ── render ────────────────────────────────────────────────────────────────

    return (
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
                    maxWidth: 760,
                    maxHeight: "90vh",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
            >
                {/* Header */}
                <div className="panel-header">
                    <div>
                        <p className="panel-section-label" style={{ marginBottom: 4 }}>
                            Backend
                        </p>
                        <h2 className="heading-md">ETL Pipeline Test</h2>
                    </div>
                    <button className="btn-icon" onClick={onClose} aria-label="Close">
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

                {/* Body */}
                <div className="panel-body">
                    {/* ── Service Status ────────────────────────────────────── */}
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
                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                                {overallHealthy ? "Backend Connected" : "Backend Degraded"}
                            </span>
                            <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                {Object.entries(health.services)
                                    .filter(([, v]) => v)
                                    .map(([k]) => k)
                                    .join(", ")}
                            </span>
                        </div>
                    )}

                    <hr className="divider" />

                    {/* ── Graph Statistics ──────────────────────────────────── */}
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
                                Neo4j Graph Statistics
                            </p>
                            <button
                                onClick={refreshStats}
                                disabled={statsLoading}
                                className="btn btn-secondary"
                                style={{ padding: "4px 10px", fontSize: "0.72rem" }}
                            >
                                {statsLoading ? "Loading…" : "Refresh"}
                            </button>
                        </div>

                        {statsError && <InlineError msg={statsError} />}

                        {stats ? (
                            <>
                                <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                                    <div className="stat-item">
                                        <div className="stat-value">{stats.node_count.toLocaleString()}</div>
                                        <div className="stat-label">Entities</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">{(stats.transaction_count ?? 0).toLocaleString()}</div>
                                        <div className="stat-label">Transactions</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">{Object.keys(stats.entity_types).length}</div>
                                        <div className="stat-label">Entity Types</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">
                                            {(stats.risk_levels["high"] || 0) + (stats.risk_levels["critical"] || 0)}
                                        </div>
                                        <div className="stat-label">High Risk</div>
                                    </div>
                                </div>
                                {Object.keys(stats.entity_types).length > 0 && (
                                    <div className="tag-list" style={{ marginTop: 10 }}>
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
                                    No graph data. Run the ETL pipeline first.
                                </p>
                            )
                        )}
                    </div>

                    <hr className="divider" />

                    {/* ── Lookup ────────────────────────────────────────────── */}
                    <div>
                        <p className="panel-section-label">Lookup Entity</p>
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                value={searchAddress}
                                onChange={(e) => setSearchAddress(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                                placeholder="0x… address"
                                className={`search-input ${searchError ? "error" : ""}`}
                                style={{ flex: 1, paddingLeft: 12 }}
                            />
                            <button
                                onClick={handleSearch}
                                disabled={searchLoading || !searchAddress.trim()}
                                className="btn btn-primary"
                            >
                                {searchLoading ? "…" : "Search"}
                            </button>
                        </div>
                        <InlineError msg={searchError} />

                        {entityResult && (
                            <div
                                style={{
                                    marginTop: 10,
                                    padding: 12,
                                    border: "1px solid var(--border-light)",
                                    borderRadius: "var(--radius-md)",
                                    background: "var(--bg-primary)",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                    <span className={`badge badge-risk-${entityResult.risk_level}`}>
                                        {entityResult.risk_level}
                                    </span>
                                    {entityResult.entity_type && (
                                        <span className="badge badge-entity">{entityResult.entity_type}</span>
                                    )}
                                </div>
                                <p className="text-mono" style={{ fontSize: "0.75rem", marginBottom: 8 }}>
                                    {entityResult.address}
                                </p>
                                {entityResult.labels.length > 0 && (
                                    <div className="tag-list" style={{ marginBottom: 8 }}>
                                        {entityResult.labels.map((l) => (
                                            <span key={l} className="tag">
                                                {l}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                                    <div className="stat-item">
                                        <div className="stat-value" style={{ fontSize: "1rem" }}>
                                            {entityResult.transaction_count?.toLocaleString() ?? "—"}
                                        </div>
                                        <div className="stat-label">Transactions</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value" style={{ fontSize: "1rem" }}>
                                            {entityResult.first_seen_block?.toLocaleString() ?? "—"}
                                        </div>
                                        <div className="stat-label">First Block</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value" style={{ fontSize: "1rem" }}>
                                            {entityResult.last_seen_block?.toLocaleString() ?? "—"}
                                        </div>
                                        <div className="stat-label">Last Block</div>
                                    </div>
                                </div>
                                {Object.keys(entityResult.properties).length > 0 && (
                                    <div style={{ marginTop: 10 }}>
                                        <p className="panel-section-label">Properties</p>
                                        <div className="props-block">
                                            <pre>{JSON.stringify(entityResult.properties, null, 2)}</pre>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {neighborsResult && neighborsResult.nodes.length > 0 && (
                            <div style={{ marginTop: 10 }}>
                                <p className="panel-section-label">
                                    Neighbors — {neighborsResult.total_nodes} entities, {neighborsResult.total_transactions} transactions
                                </p>
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(2, 1fr)",
                                        gap: 6,
                                        maxHeight: 160,
                                        overflowY: "auto",
                                    }}
                                >
                                    {neighborsResult.nodes.slice(0, 10).map((node) => (
                                        <div
                                            key={node.address}
                                            onClick={() => setSearchAddress(node.address)}
                                            style={{
                                                padding: "7px 10px",
                                                border: "1px solid var(--border-light)",
                                                borderRadius: "var(--radius-md)",
                                                background: "var(--bg-card)",
                                                cursor: "pointer",
                                            }}
                                        >
                                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                <span
                                                    style={{
                                                        width: 6,
                                                        height: 6,
                                                        borderRadius: "50%",
                                                        background: `var(--risk-${node.risk_level})`,
                                                    }}
                                                />
                                                <span className="text-mono" style={{ fontSize: "0.7rem" }}>
                                                    {formatAddress(node.address, 6)}
                                                </span>
                                            </div>
                                            {node.entity_type && (
                                                <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                                                    {node.entity_type}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                {neighborsResult.nodes.length > 10 && (
                                    <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 6 }}>
                                        Showing 10 of {neighborsResult.nodes.length}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    <hr className="divider" />

                    {/* ── Node Upsert / Update ──────────────────────────────── */}
                    <div>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                marginBottom: 10,
                            }}
                        >
                            <p className="panel-section-label" style={{ marginBottom: 0 }}>
                                Create / Update Node
                            </p>
                            <div style={{ display: "flex", gap: 4 }}>
                                {(["put", "patch"] as const).map((m) => (
                                    <button
                                        key={m}
                                        onClick={() => setUpsertMode(m)}
                                        className={`btn ${upsertMode === m ? "btn-primary" : "btn-secondary"}`}
                                        style={{ padding: "3px 10px", fontSize: "0.72rem" }}
                                    >
                                        {m === "put" ? "PUT (upsert)" : "PATCH (update)"}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <input
                                value={upsertAddr}
                                onChange={(e) => setUpsertAddr(e.target.value)}
                                placeholder="0x… address"
                                style={{ ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' }}
                            />
                            <div style={{ display: "flex", gap: 8 }}>
                                <select
                                    value={upsertType}
                                    onChange={(e) => setUpsertType(e.target.value as EntityType)}
                                    style={selectStyle}
                                >
                                    {ENTITY_TYPES.map((t) => (
                                        <option key={t} value={t}>
                                            {t}
                                        </option>
                                    ))}
                                </select>
                                <select
                                    value={upsertRisk}
                                    onChange={(e) => setUpsertRisk(e.target.value as RiskLevel)}
                                    style={selectStyle}
                                >
                                    {RISK_LEVELS.map((r) => (
                                        <option key={r} value={r}>
                                            {r}
                                        </option>
                                    ))}
                                </select>
                                <input
                                    value={upsertName}
                                    onChange={(e) => setUpsertName(e.target.value)}
                                    placeholder="Name (optional)"
                                    style={inputStyle}
                                />
                            </div>
                        </div>

                        <div style={{ marginTop: 8 }}>
                            <button
                                onClick={handleNodeUpsert}
                                disabled={upsertLoading || !upsertAddr.trim()}
                                className="btn btn-primary"
                            >
                                {upsertLoading ? "…" : upsertMode === "put" ? "PUT Node" : "PATCH Node"}
                            </button>
                        </div>

                        <InlineError msg={upsertError} />
                        <InlineSuccess msg={upsertSuccess} />

                        {upsertResult && (
                            <div style={{ marginTop: 8 }}>
                                <p className="panel-section-label">Result</p>
                                <div className="props-block">
                                    <pre>{JSON.stringify(upsertResult, null, 2)}</pre>
                                </div>
                            </div>
                        )}
                    </div>

                    <hr className="divider" />

                    {/* ── Node Delete ───────────────────────────────────────── */}
                    <div>
                        <p className="panel-section-label">Delete Node</p>
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                value={deleteAddr}
                                onChange={(e) => setDeleteAddr(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleNodeDelete()}
                                placeholder="0x… address to delete"
                                style={{ ...inputStyle, flex: 1, fontFamily: '"SF Mono","Fira Code",monospace' }}
                            />
                            <button
                                onClick={handleNodeDelete}
                                disabled={deleteLoading || !deleteAddr.trim()}
                                className="btn"
                                style={{ background: "var(--risk-critical)", color: "#fff", border: "none" }}
                            >
                                {deleteLoading ? "…" : "Delete"}
                            </button>
                        </div>
                        <InlineError msg={deleteError} />
                        <InlineSuccess msg={deleteSuccess} />
                    </div>

                    <hr className="divider" />

                    {/* ── Transaction Upsert ────────────────────────────────── */}
                    <div>
                        <p className="panel-section-label">Upsert Transaction Node</p>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <input
                                value={txHash}
                                onChange={(e) => setTxHash(e.target.value)}
                                placeholder="Transaction hash (0x…)"
                                style={{ ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' }}
                            />
                            <div style={{ display: "flex", gap: 8 }}>
                                <input
                                    value={txFrom}
                                    onChange={(e) => setTxFrom(e.target.value)}
                                    placeholder="From 0x…"
                                    style={{ ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' }}
                                />
                                <input
                                    value={txTo}
                                    onChange={(e) => setTxTo(e.target.value)}
                                    placeholder="To 0x…"
                                    style={{ ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' }}
                                />
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                                <input
                                    value={txValue}
                                    onChange={(e) => setTxValue(e.target.value)}
                                    placeholder="Value in wei (optional)"
                                    style={inputStyle}
                                />
                                <input
                                    value={txBlock}
                                    onChange={(e) => setTxBlock(e.target.value)}
                                    placeholder="Block number (optional)"
                                    style={{ ...inputStyle, width: 160, flex: "none" }}
                                />
                            </div>
                        </div>
                        <div style={{ marginTop: 8 }}>
                            <button
                                onClick={handleTxUpsert}
                                disabled={txLoading || !txHash.trim() || !txFrom.trim() || !txTo.trim()}
                                className="btn btn-primary"
                            >
                                {txLoading ? "…" : "Upsert Transaction"}
                            </button>
                        </div>
                        <InlineError msg={txError} />
                        <InlineSuccess msg={txSuccess} />
                        {txResult && (
                            <div style={{ marginTop: 8 }}>
                                <p className="panel-section-label">Result</p>
                                <div className="props-block">
                                    <pre>{JSON.stringify(txResult, null, 2)}</pre>
                                </div>
                            </div>
                        )}
                    </div>

                    <hr className="divider" />

                    {/* ── Edge Delete ───────────────────────────────────────── */}
                    <div>
                        <p className="panel-section-label">Delete Edge</p>
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                value={delEdgeSrc}
                                onChange={(e) => setDelEdgeSrc(e.target.value)}
                                placeholder="Source 0x…"
                                style={{ ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' }}
                            />
                            <input
                                value={delEdgeTgt}
                                onChange={(e) => setDelEdgeTgt(e.target.value)}
                                placeholder="Target 0x…"
                                style={{ ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' }}
                            />
                            <input
                                value={delEdgeType}
                                onChange={(e) => setDelEdgeType(e.target.value)}
                                placeholder="Edge type"
                                style={{ ...inputStyle, width: 130, flex: "none" }}
                            />
                            <button
                                onClick={handleEdgeDelete}
                                disabled={delEdgeLoading || !delEdgeSrc.trim() || !delEdgeTgt.trim()}
                                className="btn"
                                style={{
                                    background: "var(--risk-critical)",
                                    color: "#fff",
                                    border: "none",
                                    flexShrink: 0,
                                }}
                            >
                                {delEdgeLoading ? "…" : "Delete"}
                            </button>
                        </div>
                        <InlineError msg={delEdgeError} />
                        <InlineSuccess msg={delEdgeSuccess} />
                    </div>

                    <hr className="divider" />

                    {/* ── Instructions ─────────────────────────────────────── */}
                    <div>
                        <p className="panel-section-label">Testing Instructions</p>
                        <div
                            style={{
                                padding: 12,
                                border: "1px solid var(--border-light)",
                                borderRadius: "var(--radius-md)",
                                background: "var(--bg-primary)",
                                fontSize: "0.78rem",
                                lineHeight: 1.6,
                            }}
                        >
                            <ol style={{ margin: 0, paddingLeft: 18 }}>
                                <li style={{ marginBottom: 6 }}>
                                    Start infrastructure: <code>docker compose up -d</code>
                                </li>
                                <li style={{ marginBottom: 6 }}>
                                    Start Dagster: <code>dagster dev -f src/etl/definitions.py</code>
                                </li>
                                <li style={{ marginBottom: 6 }}>
                                    Materialize assets: <code>{`{start_block: 18000000, end_block: 18000010}`}</code>
                                </li>
                                <li style={{ marginBottom: 6 }}>Refresh stats → verify entity / transaction counts increased</li>
                                <li style={{ marginBottom: 6 }}>
                                    Use <strong>Lookup</strong> to confirm addresses exist in Neo4j
                                </li>
                                <li style={{ marginBottom: 6 }}>
                                    Use <strong>PUT Node</strong> to create a test entity; <strong>PATCH Node</strong>{" "}
                                    to update it
                                </li>
                                <li>
                                    Use <strong>Upsert Transaction</strong> to create a Transaction node with
                                    SENT/RECEIVED relationships between two entities
                                </li>
                            </ol>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
