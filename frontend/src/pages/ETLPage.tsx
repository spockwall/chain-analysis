/**
 * ETL Page — test and manage the backend ETL pipeline.
 * Covers: graph stats, entity lookup, node upsert/update/delete, transaction upsert, edge delete.
 */
import { useState } from "react";
import { useHealth } from "../hooks/useHealth";
import { useGraphStats } from "../hooks/useGraphStats";
import { useToastContext } from "../context/ToastContext";
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

// ── section card wrapper ──────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <p className="panel-section-label" style={{ marginBottom: 14 }}>
                {title}
            </p>
            {children}
        </div>
    );
}

// ── main component ────────────────────────────────────────────────────────────

export function ETLPage() {
    const toast = useToastContext();
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
    const [entityResult, setEntityResult] = useState<EntityResponse | null>(null);
    const [neighborsResult, setNeighborsResult] = useState<NeighborsResponse | null>(null);

    // ── Node upsert state ──────────────────────────────────────────────────────
    const [upsertAddr, setUpsertAddr] = useState("");
    const [upsertType, setUpsertType] = useState<EntityType>("EOA");
    const [upsertRisk, setUpsertRisk] = useState<RiskLevel>("unknown");
    const [upsertName, setUpsertName] = useState("");
    const [upsertMode, setUpsertMode] = useState<"put" | "patch">("put");
    const [upsertLoading, setUpsertLoading] = useState(false);
    const [upsertResult, setUpsertResult] = useState<EntityResponse | null>(null);

    // ── Node delete state ──────────────────────────────────────────────────────
    const [deleteAddr, setDeleteAddr] = useState("");
    const [deleteLoading, setDeleteLoading] = useState(false);

    // ── Transaction upsert state ───────────────────────────────────────────────
    const [txHash, setTxHash] = useState("");
    const [txFrom, setTxFrom] = useState("");
    const [txTo, setTxTo] = useState("");
    const [txValue, setTxValue] = useState("");
    const [txBlock, setTxBlock] = useState("");
    const [txLoading, setTxLoading] = useState(false);
    const [txResult, setTxResult] = useState<TransactionResponse | null>(null);

    // ── Edge delete state ──────────────────────────────────────────────────────
    const [delEdgeSrc, setDelEdgeSrc] = useState("");
    const [delEdgeTgt, setDelEdgeTgt] = useState("");
    const [delEdgeType, setDelEdgeType] = useState("TRANSFER");
    const [delEdgeLoading, setDelEdgeLoading] = useState(false);

    const overallHealthy = health?.status === "healthy";

    // ── handlers ──────────────────────────────────────────────────────────────

    const handleSearch = async () => {
        const addr = searchAddress.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            toast.error("Must be 0x followed by 40 hex characters.");
            return;
        }
        setSearchLoading(true);
        setEntityResult(null);
        setNeighborsResult(null);
        const id = toast.loading("Searching…");
        try {
            const [entity, neighbors] = await Promise.all([
                fetchEntity(addr),
                fetchNeighbors(addr, { depth: 1, limit: 20 }),
            ]);
            setEntityResult(entity);
            setNeighborsResult(neighbors);
            toast.dismiss(id);
            toast.success(`Found: ${formatAddress(addr)}`);
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setSearchLoading(false);
        }
    };

    const handleTxUpsert = async () => {
        const from = txFrom.trim().toLowerCase();
        const to = txTo.trim().toLowerCase();
        const hash = txHash.trim();
        if (!hash) {
            toast.error("Transaction hash is required.");
            return;
        }
        if (!isValidAddress(from)) {
            toast.error("Invalid from address.");
            return;
        }
        if (!isValidAddress(to)) {
            toast.error("Invalid to address.");
            return;
        }
        setTxLoading(true);
        setTxResult(null);
        const id = toast.loading("Upserting transaction…");
        try {
            await upsertEdge(from, to, {
                source: from,
                target: to,
                edge_type: "TRANSFER",
                value: txValue || undefined,
                tx_hash: hash,
                block_number: txBlock ? parseInt(txBlock, 10) : undefined,
            });
            const result: TransactionResponse = {
                hash,
                from_address: from,
                to_address: to,
                value: txValue || null,
                block_number: txBlock ? parseInt(txBlock, 10) : null,
                properties: {},
            };
            setTxResult(result);
            toast.dismiss(id);
            toast.success(`Transaction upserted: ${hash.slice(0, 14)}…`);
            refreshStats();
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setTxLoading(false);
        }
    };

    const handleNodeUpsert = async () => {
        const addr = upsertAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            toast.error("Invalid address format.");
            return;
        }
        setUpsertLoading(true);
        setUpsertResult(null);
        const id = toast.loading(upsertMode === "put" ? "Upserting node…" : "Updating node…");
        try {
            const body = {
                address: addr,
                entity_type: upsertType,
                risk_level: upsertRisk,
                name: upsertName || undefined,
            };
            const result = upsertMode === "put" ? await upsertEntity(addr, body) : await updateEntity(addr, body);
            setUpsertResult(result);
            toast.dismiss(id);
            toast.success(`${upsertMode === "put" ? "Upserted" : "Updated"}: ${formatAddress(addr)}`);
            refreshStats();
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setUpsertLoading(false);
        }
    };

    const handleNodeDelete = async () => {
        const addr = deleteAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            toast.error("Invalid address format.");
            return;
        }
        setDeleteLoading(true);
        const id = toast.loading("Deleting node…");
        try {
            await deleteEntity(addr);
            toast.dismiss(id);
            toast.success(`Deleted: ${formatAddress(addr)}`);
            setDeleteAddr("");
            refreshStats();
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setDeleteLoading(false);
        }
    };

    const handleEdgeDelete = async () => {
        const src = delEdgeSrc.trim().toLowerCase();
        const tgt = delEdgeTgt.trim().toLowerCase();
        if (!isValidAddress(src)) {
            toast.error("Invalid source address.");
            return;
        }
        if (!isValidAddress(tgt)) {
            toast.error("Invalid target address.");
            return;
        }
        setDelEdgeLoading(true);
        const id = toast.loading("Deleting edge…");
        try {
            await deleteEdge(src, tgt, delEdgeType || "TRANSFER");
            toast.dismiss(id);
            toast.success(`Deleted edge: ${formatAddress(src)} → ${formatAddress(tgt)}`);
            refreshStats();
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
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

    const selectStyle: React.CSSProperties = { ...inputStyle, flex: "none", cursor: "pointer" };
    const monoInput: React.CSSProperties = { ...inputStyle, fontFamily: '"SF Mono","Fira Code",monospace' };

    // ── render ────────────────────────────────────────────────────────────────

    return (
        <div className="page-content">
            <div className="page-padded">
                {/* Page header */}
                <div style={{ marginBottom: 28 }}>
                    <p className="panel-section-label" style={{ marginBottom: 4 }}>
                        Backend
                    </p>
                    <h1 className="heading-md" style={{ fontSize: "1.5rem", margin: 0 }}>
                        ETL Pipeline
                    </h1>
                </div>

                {/* ── Service Status ────────────────────────────────────── */}
                {health && (
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 16px",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid",
                            borderColor: overallHealthy ? "rgba(34,197,94,0.3)" : "rgba(234,179,8,0.3)",
                            background: overallHealthy ? "rgba(34,197,94,0.06)" : "rgba(234,179,8,0.06)",
                            marginBottom: 20,
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

                {/* ── Graph Statistics ──────────────────────────────────── */}
                <div className="card" style={{ padding: 20, marginBottom: 16 }}>
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 14,
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
                    {statsError && (
                        <p style={{ fontSize: "0.78rem", color: "var(--risk-critical)", marginBottom: 10 }}>
                            {statsError}
                        </p>
                    )}
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
                                <div className="tag-list" style={{ marginTop: 12 }}>
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

                {/* ── Lookup ────────────────────────────────────────────── */}
                <Section title="Lookup Entity">
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            value={searchAddress}
                            onChange={(e) => setSearchAddress(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                            placeholder="0x… address"
                            className="search-input"
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

                    {entityResult && (
                        <div
                            style={{
                                marginTop: 12,
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
                        <div style={{ marginTop: 12 }}>
                            <p className="panel-section-label">
                                Neighbors — {neighborsResult.total_nodes} entities, {neighborsResult.total_transactions}{" "}
                                transactions
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
                </Section>

                {/* ── Node Upsert / Update ──────────────────────────────── */}
                <Section title="Create / Update Node">
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
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
                            style={monoInput}
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

                    <div style={{ marginTop: 10 }}>
                        <button
                            onClick={handleNodeUpsert}
                            disabled={upsertLoading || !upsertAddr.trim()}
                            className="btn btn-primary"
                        >
                            {upsertLoading ? "…" : upsertMode === "put" ? "PUT Node" : "PATCH Node"}
                        </button>
                    </div>

                    {upsertResult && (
                        <div style={{ marginTop: 10 }}>
                            <p className="panel-section-label">Result</p>
                            <div className="props-block">
                                <pre>{JSON.stringify(upsertResult, null, 2)}</pre>
                            </div>
                        </div>
                    )}
                </Section>

                {/* ── Node Delete ───────────────────────────────────────── */}
                <Section title="Delete Node">
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            value={deleteAddr}
                            onChange={(e) => setDeleteAddr(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleNodeDelete()}
                            placeholder="0x… address to delete"
                            style={{ ...monoInput, flex: 1 }}
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
                </Section>

                {/* ── Transaction Upsert ────────────────────────────────── */}
                <Section title="Upsert Transaction Node">
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <input
                            value={txHash}
                            onChange={(e) => setTxHash(e.target.value)}
                            placeholder="Transaction hash (0x…)"
                            style={monoInput}
                        />
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                value={txFrom}
                                onChange={(e) => setTxFrom(e.target.value)}
                                placeholder="From 0x…"
                                style={monoInput}
                            />
                            <input
                                value={txTo}
                                onChange={(e) => setTxTo(e.target.value)}
                                placeholder="To 0x…"
                                style={monoInput}
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
                                style={{ ...inputStyle, width: 180, flex: "none" }}
                            />
                        </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <button
                            onClick={handleTxUpsert}
                            disabled={txLoading || !txHash.trim() || !txFrom.trim() || !txTo.trim()}
                            className="btn btn-primary"
                        >
                            {txLoading ? "…" : "Upsert Transaction"}
                        </button>
                    </div>
                    {txResult && (
                        <div style={{ marginTop: 10 }}>
                            <p className="panel-section-label">Result</p>
                            <div className="props-block">
                                <pre>{JSON.stringify(txResult, null, 2)}</pre>
                            </div>
                        </div>
                    )}
                </Section>

                {/* ── Edge Delete ───────────────────────────────────────── */}
                <Section title="Delete Edge">
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            value={delEdgeSrc}
                            onChange={(e) => setDelEdgeSrc(e.target.value)}
                            placeholder="Source 0x…"
                            style={monoInput}
                        />
                        <input
                            value={delEdgeTgt}
                            onChange={(e) => setDelEdgeTgt(e.target.value)}
                            placeholder="Target 0x…"
                            style={monoInput}
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
                            style={{ background: "var(--risk-critical)", color: "#fff", border: "none", flexShrink: 0 }}
                        >
                            {delEdgeLoading ? "…" : "Delete"}
                        </button>
                    </div>
                </Section>

                {/* ── Instructions ─────────────────────────────────────── */}
                <Section title="Testing Instructions">
                    <div
                        style={{
                            padding: 14,
                            border: "1px solid var(--border-light)",
                            borderRadius: "var(--radius-md)",
                            background: "var(--bg-primary)",
                            fontSize: "0.78rem",
                            lineHeight: 1.7,
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
                            <li style={{ marginBottom: 6 }}>
                                Refresh stats → verify entity / transaction counts increased
                            </li>
                            <li style={{ marginBottom: 6 }}>
                                Use <strong>Lookup</strong> to confirm addresses exist in Neo4j
                            </li>
                            <li style={{ marginBottom: 6 }}>
                                Use <strong>PUT Node</strong> to create a test entity; <strong>PATCH Node</strong> to
                                update it
                            </li>
                            <li>
                                Use <strong>Upsert Transaction</strong> to create a Transaction node with SENT/RECEIVED
                                relationships
                            </li>
                        </ol>
                    </div>
                </Section>
            </div>
        </div>
    );
}
