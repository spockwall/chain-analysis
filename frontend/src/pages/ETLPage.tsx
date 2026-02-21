/**
 * ETL Page — test and manage the backend ETL pipeline.
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

const ENTITY_TYPES: EntityType[] = [
    "EOA", "Contract", "Mixer", "LendingPool", "Bridge", "DEX", "CEXHotWallet", "Application", "Unknown",
];
const RISK_LEVELS: RiskLevel[] = ["unknown", "low", "medium", "high", "critical"];

function isValidAddress(addr: string) {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// shared Tailwind class strings
const inputCls = "flex-1 px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-[inherit] bg-white text-gray-900 outline-none transition-colors focus:border-gray-400";
const monoCls  = "flex-1 px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-mono bg-white text-gray-900 outline-none transition-colors focus:border-gray-400";
const selectCls = "px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-[inherit] bg-white text-gray-900 outline-none cursor-pointer";
const btnPrimary = "inline-flex items-center justify-center gap-1.5 px-4 py-[7px] bg-gray-900 text-white text-[0.78rem] font-semibold rounded-lg border-none cursor-pointer transition-all hover:-translate-y-px hover:bg-[#1e293b] disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0";
const btnSecondary = "inline-flex items-center justify-center gap-1.5 px-3 py-[5px] bg-white text-gray-700 text-[0.72rem] font-medium rounded-lg border border-gray-200 cursor-pointer transition-colors hover:bg-gray-50 disabled:opacity-45 disabled:cursor-not-allowed";
const btnDanger = "inline-flex items-center justify-center gap-1.5 px-4 py-[7px] bg-red-500 text-white text-[0.78rem] font-semibold rounded-lg border-none cursor-pointer shrink-0 transition-colors hover:bg-red-600 disabled:opacity-45 disabled:cursor-not-allowed";
const sectionLabel = "text-[0.65rem] font-semibold tracking-widest uppercase text-gray-400";
const propsBlock = "bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-[0.7rem] text-gray-500 overflow-x-auto";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
            <p className={`${sectionLabel} mb-3.5`}>{title}</p>
            {children}
        </div>
    );
}

export function ETLPage() {
    const toast = useToastContext();
    const { health } = useHealth({ refreshInterval: 30000 });
    const { stats, loading: statsLoading, error: statsError, refresh: refreshStats } = useGraphStats({ refreshInterval: 10000 });

    const [searchAddress, setSearchAddress] = useState("");
    const [searchLoading, setSearchLoading] = useState(false);
    const [entityResult, setEntityResult] = useState<EntityResponse | null>(null);
    const [neighborsResult, setNeighborsResult] = useState<NeighborsResponse | null>(null);

    const [upsertAddr, setUpsertAddr] = useState("");
    const [upsertType, setUpsertType] = useState<EntityType>("EOA");
    const [upsertRisk, setUpsertRisk] = useState<RiskLevel>("unknown");
    const [upsertName, setUpsertName] = useState("");
    const [upsertMode, setUpsertMode] = useState<"put" | "patch">("put");
    const [upsertLoading, setUpsertLoading] = useState(false);
    const [upsertResult, setUpsertResult] = useState<EntityResponse | null>(null);

    const [deleteAddr, setDeleteAddr] = useState("");
    const [deleteLoading, setDeleteLoading] = useState(false);

    const [txHash, setTxHash] = useState("");
    const [txFrom, setTxFrom] = useState("");
    const [txTo, setTxTo] = useState("");
    const [txValue, setTxValue] = useState("");
    const [txBlock, setTxBlock] = useState("");
    const [txLoading, setTxLoading] = useState(false);
    const [txResult, setTxResult] = useState<TransactionResponse | null>(null);

    const [delEdgeSrc, setDelEdgeSrc] = useState("");
    const [delEdgeTgt, setDelEdgeTgt] = useState("");
    const [delEdgeType, setDelEdgeType] = useState("TRANSFER");
    const [delEdgeLoading, setDelEdgeLoading] = useState(false);

    const overallHealthy = health?.status === "healthy";

    const handleSearch = async () => {
        const addr = searchAddress.trim().toLowerCase();
        if (!isValidAddress(addr)) { toast.error("Must be 0x followed by 40 hex characters."); return; }
        setSearchLoading(true); setEntityResult(null); setNeighborsResult(null);
        const id = toast.loading("Searching…");
        try {
            const [entity, neighbors] = await Promise.all([fetchEntity(addr), fetchNeighbors(addr, { depth: 1, limit: 20 })]);
            setEntityResult(entity); setNeighborsResult(neighbors);
            toast.dismiss(id); toast.success(`Found: ${formatAddress(addr)}`);
        } catch (err) { toast.dismiss(id); toast.error(err instanceof Error ? err.message : "Request failed"); }
        finally { setSearchLoading(false); }
    };

    const handleNodeUpsert = async () => {
        const addr = upsertAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) { toast.error("Invalid address format."); return; }
        setUpsertLoading(true); setUpsertResult(null);
        const id = toast.loading(upsertMode === "put" ? "Upserting node…" : "Updating node…");
        try {
            const body = { address: addr, entity_type: upsertType, risk_level: upsertRisk, name: upsertName || undefined };
            const result = upsertMode === "put" ? await upsertEntity(addr, body) : await updateEntity(addr, body);
            setUpsertResult(result); toast.dismiss(id);
            toast.success(`${upsertMode === "put" ? "Upserted" : "Updated"}: ${formatAddress(addr)}`);
            refreshStats();
        } catch (err) { toast.dismiss(id); toast.error(err instanceof Error ? err.message : "Request failed"); }
        finally { setUpsertLoading(false); }
    };

    const handleNodeDelete = async () => {
        const addr = deleteAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) { toast.error("Invalid address format."); return; }
        setDeleteLoading(true);
        const id = toast.loading("Deleting node…");
        try {
            await deleteEntity(addr); toast.dismiss(id); toast.success(`Deleted: ${formatAddress(addr)}`);
            setDeleteAddr(""); refreshStats();
        } catch (err) { toast.dismiss(id); toast.error(err instanceof Error ? err.message : "Request failed"); }
        finally { setDeleteLoading(false); }
    };

    const handleTxUpsert = async () => {
        const from = txFrom.trim().toLowerCase();
        const to   = txTo.trim().toLowerCase();
        const hash = txHash.trim();
        if (!hash) { toast.error("Transaction hash is required."); return; }
        if (!isValidAddress(from)) { toast.error("Invalid from address."); return; }
        if (!isValidAddress(to))   { toast.error("Invalid to address.");   return; }
        setTxLoading(true); setTxResult(null);
        const id = toast.loading("Upserting transaction…");
        try {
            await upsertEdge(from, to, { source: from, target: to, edge_type: "TRANSFER", value: txValue || undefined, tx_hash: hash, block_number: txBlock ? parseInt(txBlock, 10) : undefined });
            const result: TransactionResponse = { hash, from_address: from, to_address: to, value: txValue || null, block_number: txBlock ? parseInt(txBlock, 10) : null, properties: {} };
            setTxResult(result); toast.dismiss(id); toast.success(`Transaction upserted: ${hash.slice(0, 14)}…`);
            refreshStats();
        } catch (err) { toast.dismiss(id); toast.error(err instanceof Error ? err.message : "Request failed"); }
        finally { setTxLoading(false); }
    };

    const handleEdgeDelete = async () => {
        const src = delEdgeSrc.trim().toLowerCase();
        const tgt = delEdgeTgt.trim().toLowerCase();
        if (!isValidAddress(src)) { toast.error("Invalid source address."); return; }
        if (!isValidAddress(tgt)) { toast.error("Invalid target address."); return; }
        setDelEdgeLoading(true);
        const id = toast.loading("Deleting edge…");
        try {
            await deleteEdge(src, tgt, delEdgeType || "TRANSFER");
            toast.dismiss(id); toast.success(`Deleted edge: ${formatAddress(src)} → ${formatAddress(tgt)}`);
            refreshStats();
        } catch (err) { toast.dismiss(id); toast.error(err instanceof Error ? err.message : "Request failed"); }
        finally { setDelEdgeLoading(false); }
    };

    return (
        <div className="flex-1 min-h-0 overflow-auto bg-gray-50">
            <div className="max-w-[860px] mx-auto px-6 py-8">
                {/* Header */}
                <div className="mb-7">
                    <p className={`${sectionLabel} mb-1`}>Backend</p>
                    <h1 className="text-[1.5rem] font-semibold text-gray-900 tracking-[-0.01em] m-0">ETL Pipeline</h1>
                </div>

                {/* Service status banner */}
                {health && (
                    <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg border mb-5 ${overallHealthy ? "border-green-200/60 bg-green-500/[0.06]" : "border-yellow-200/60 bg-yellow-500/[0.06]"}`}>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${overallHealthy ? "bg-green-500" : "bg-yellow-500"}`} />
                        <span className="text-[0.8rem] font-semibold text-gray-900">
                            {overallHealthy ? "Backend Connected" : "Backend Degraded"}
                        </span>
                        <span className="ml-auto text-[0.7rem] text-gray-400">
                            {Object.entries(health.services).filter(([, v]) => v).map(([k]) => k).join(", ")}
                        </span>
                    </div>
                )}

                {/* Graph Statistics */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                    <div className="flex justify-between items-center mb-4">
                        <p className={`${sectionLabel}`}>Neo4j Graph Statistics</p>
                        <button onClick={refreshStats} disabled={statsLoading} className={btnSecondary}>
                            {statsLoading ? "Loading…" : "Refresh"}
                        </button>
                    </div>
                    {statsError && <p className="text-[0.78rem] text-red-500 mb-2.5">{statsError}</p>}
                    {stats ? (
                        <>
                            <div className="grid grid-cols-4 gap-3">
                                {[
                                    { v: stats.node_count.toLocaleString(), l: "Entities" },
                                    { v: (stats.transaction_count ?? 0).toLocaleString(), l: "Transactions" },
                                    { v: Object.keys(stats.entity_types).length, l: "Entity Types" },
                                    { v: (stats.risk_levels["high"] || 0) + (stats.risk_levels["critical"] || 0), l: "High Risk" },
                                ].map(({ v, l }) => (
                                    <div key={l}>
                                        <div className="text-[1.4rem] font-bold text-gray-900 tracking-[-0.02em] leading-none">{v}</div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">{l}</div>
                                    </div>
                                ))}
                            </div>
                            {Object.keys(stats.entity_types).length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-3">
                                    {Object.entries(stats.entity_types).map(([type, count]) => (
                                        <span key={type} className="px-2 py-[3px] bg-gray-50 border border-gray-200 rounded text-[0.7rem] text-gray-500">
                                            {type}: {count}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        !statsLoading && <p className="text-[0.78rem] text-gray-400">No graph data. Run the ETL pipeline first.</p>
                    )}
                </div>

                {/* Lookup */}
                <Section title="Lookup Entity">
                    <div className="flex gap-2">
                        <input
                            value={searchAddress}
                            onChange={(e) => setSearchAddress(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                            placeholder="0x… address"
                            className={monoCls}
                        />
                        <button onClick={handleSearch} disabled={searchLoading || !searchAddress.trim()} className={btnPrimary}>
                            {searchLoading ? "…" : "Search"}
                        </button>
                    </div>

                    {entityResult && (
                        <div className="mt-3 p-3 border border-gray-200 rounded-lg bg-gray-50">
                            <div className="flex items-center gap-2 mb-2">
                                <span className={`inline-flex items-center px-2 py-[3px] rounded text-[0.65rem] font-semibold uppercase ${
                                    { unknown: "bg-slate-100 text-slate-500", low: "bg-green-100 text-green-700", medium: "bg-yellow-100 text-yellow-700", high: "bg-orange-100 text-orange-700", critical: "bg-red-100 text-red-700" }[entityResult.risk_level]
                                }`}>{entityResult.risk_level}</span>
                                {entityResult.entity_type && (
                                    <span className="inline-flex items-center px-2 py-[3px] rounded text-[0.65rem] font-semibold uppercase bg-violet-50 text-violet-700">
                                        {entityResult.entity_type}
                                    </span>
                                )}
                            </div>
                            <p className="font-mono text-[0.75rem] text-gray-600 mb-2">{entityResult.address}</p>
                            {entityResult.labels.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                    {entityResult.labels.map((l) => (
                                        <span key={l} className="px-2 py-[3px] bg-white border border-gray-200 rounded text-[0.7rem] text-gray-500">{l}</span>
                                    ))}
                                </div>
                            )}
                            <div className="grid grid-cols-3 gap-3">
                                {[
                                    { v: entityResult.transaction_count?.toLocaleString() ?? "—", l: "Transactions" },
                                    { v: entityResult.first_seen_block?.toLocaleString() ?? "—", l: "First Block" },
                                    { v: entityResult.last_seen_block?.toLocaleString() ?? "—", l: "Last Block" },
                                ].map(({ v, l }) => (
                                    <div key={l}>
                                        <div className="text-[1rem] font-bold text-gray-900 leading-none">{v}</div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">{l}</div>
                                    </div>
                                ))}
                            </div>
                            {Object.keys(entityResult.properties).length > 0 && (
                                <div className="mt-2.5">
                                    <p className={`${sectionLabel} mb-1.5`}>Properties</p>
                                    <div className={propsBlock}><pre className="m-0 font-mono">{JSON.stringify(entityResult.properties, null, 2)}</pre></div>
                                </div>
                            )}
                        </div>
                    )}

                    {neighborsResult && neighborsResult.nodes.length > 0 && (
                        <div className="mt-3">
                            <p className={`${sectionLabel} mb-2`}>
                                Neighbors — {neighborsResult.total_nodes} entities, {neighborsResult.total_transactions} transactions
                            </p>
                            <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                                {neighborsResult.nodes.slice(0, 10).map((node) => (
                                    <button
                                        key={node.address}
                                        onClick={() => setSearchAddress(node.address)}
                                        className="flex flex-col gap-0.5 px-2.5 py-1.5 border border-gray-200 rounded-lg bg-white text-left cursor-pointer transition-colors hover:bg-gray-50"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: `var(--risk-${node.risk_level})` }} />
                                            <span className="font-mono text-[0.7rem] text-gray-700">{formatAddress(node.address, 6)}</span>
                                        </div>
                                        {node.entity_type && <span className="text-[0.65rem] text-gray-400">{node.entity_type}</span>}
                                    </button>
                                ))}
                            </div>
                            {neighborsResult.nodes.length > 10 && (
                                <p className="text-[0.7rem] text-gray-400 mt-1.5">Showing 10 of {neighborsResult.nodes.length}</p>
                            )}
                        </div>
                    )}
                </Section>

                {/* Create / Update Node */}
                <Section title="Create / Update Node">
                    <div className="flex justify-end mb-2.5">
                        <div className="flex gap-1">
                            {(["put", "patch"] as const).map((m) => (
                                <button
                                    key={m}
                                    onClick={() => setUpsertMode(m)}
                                    className={upsertMode === m
                                        ? "px-3 py-[3px] text-[0.72rem] font-semibold rounded-lg bg-gray-900 text-white border-none cursor-pointer"
                                        : "px-3 py-[3px] text-[0.72rem] font-medium rounded-lg bg-white text-gray-700 border border-gray-200 cursor-pointer hover:bg-gray-50"
                                    }
                                >
                                    {m === "put" ? "PUT (upsert)" : "PATCH (update)"}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <input value={upsertAddr} onChange={(e) => setUpsertAddr(e.target.value)} placeholder="0x… address" className={monoCls} />
                        <div className="flex gap-2">
                            <select value={upsertType} onChange={(e) => setUpsertType(e.target.value as EntityType)} className={selectCls}>
                                {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                            <select value={upsertRisk} onChange={(e) => setUpsertRisk(e.target.value as RiskLevel)} className={selectCls}>
                                {RISK_LEVELS.map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                            <input value={upsertName} onChange={(e) => setUpsertName(e.target.value)} placeholder="Name (optional)" className={inputCls} />
                        </div>
                    </div>
                    <div className="mt-2.5">
                        <button onClick={handleNodeUpsert} disabled={upsertLoading || !upsertAddr.trim()} className={btnPrimary}>
                            {upsertLoading ? "…" : upsertMode === "put" ? "PUT Node" : "PATCH Node"}
                        </button>
                    </div>
                    {upsertResult && (
                        <div className="mt-2.5">
                            <p className={`${sectionLabel} mb-1.5`}>Result</p>
                            <div className={propsBlock}><pre className="m-0 font-mono">{JSON.stringify(upsertResult, null, 2)}</pre></div>
                        </div>
                    )}
                </Section>

                {/* Delete Node */}
                <Section title="Delete Node">
                    <div className="flex gap-2">
                        <input
                            value={deleteAddr}
                            onChange={(e) => setDeleteAddr(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleNodeDelete()}
                            placeholder="0x… address to delete"
                            className={monoCls}
                        />
                        <button onClick={handleNodeDelete} disabled={deleteLoading || !deleteAddr.trim()} className={btnDanger}>
                            {deleteLoading ? "…" : "Delete"}
                        </button>
                    </div>
                </Section>

                {/* Upsert Transaction */}
                <Section title="Upsert Transaction Node">
                    <div className="flex flex-col gap-2">
                        <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Transaction hash (0x…)" className={monoCls} />
                        <div className="flex gap-2">
                            <input value={txFrom} onChange={(e) => setTxFrom(e.target.value)} placeholder="From 0x…" className={monoCls} />
                            <input value={txTo}   onChange={(e) => setTxTo(e.target.value)}   placeholder="To 0x…"   className={monoCls} />
                        </div>
                        <div className="flex gap-2">
                            <input value={txValue} onChange={(e) => setTxValue(e.target.value)} placeholder="Value in wei (optional)" className={inputCls} />
                            <input value={txBlock} onChange={(e) => setTxBlock(e.target.value)} placeholder="Block number (optional)" className="w-44 shrink-0 px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-[inherit] bg-white text-gray-900 outline-none focus:border-gray-400" />
                        </div>
                    </div>
                    <div className="mt-2.5">
                        <button onClick={handleTxUpsert} disabled={txLoading || !txHash.trim() || !txFrom.trim() || !txTo.trim()} className={btnPrimary}>
                            {txLoading ? "…" : "Upsert Transaction"}
                        </button>
                    </div>
                    {txResult && (
                        <div className="mt-2.5">
                            <p className={`${sectionLabel} mb-1.5`}>Result</p>
                            <div className={propsBlock}><pre className="m-0 font-mono">{JSON.stringify(txResult, null, 2)}</pre></div>
                        </div>
                    )}
                </Section>

                {/* Delete Edge */}
                <Section title="Delete Edge">
                    <div className="flex gap-2">
                        <input value={delEdgeSrc} onChange={(e) => setDelEdgeSrc(e.target.value)} placeholder="Source 0x…" className={monoCls} />
                        <input value={delEdgeTgt} onChange={(e) => setDelEdgeTgt(e.target.value)} placeholder="Target 0x…" className={monoCls} />
                        <input value={delEdgeType} onChange={(e) => setDelEdgeType(e.target.value)} placeholder="Edge type" className="w-32 shrink-0 px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-[inherit] bg-white text-gray-900 outline-none focus:border-gray-400" />
                        <button onClick={handleEdgeDelete} disabled={delEdgeLoading || !delEdgeSrc.trim() || !delEdgeTgt.trim()} className={btnDanger}>
                            {delEdgeLoading ? "…" : "Delete"}
                        </button>
                    </div>
                </Section>

                {/* Instructions */}
                <Section title="Testing Instructions">
                    <div className="p-3.5 border border-gray-200 rounded-lg bg-gray-50 text-[0.78rem] leading-[1.7] text-gray-600">
                        <ol className="m-0 pl-[18px]">
                            <li className="mb-1.5">Start infrastructure: <code className="font-mono">docker compose up -d</code></li>
                            <li className="mb-1.5">Start Dagster: <code className="font-mono">dagster dev -f src/etl/definitions.py</code></li>
                            <li className="mb-1.5">Materialize assets: <code className="font-mono">{`{start_block: 18000000, end_block: 18000010}`}</code></li>
                            <li className="mb-1.5">Refresh stats → verify entity / transaction counts increased</li>
                            <li className="mb-1.5">Use <strong>Lookup</strong> to confirm addresses exist in Neo4j</li>
                            <li className="mb-1.5">Use <strong>PUT Node</strong> to create a test entity; <strong>PATCH Node</strong> to update it</li>
                            <li>Use <strong>Upsert Transaction</strong> to create a Transaction node with SENT/RECEIVED relationships</li>
                        </ol>
                    </div>
                </Section>
            </div>
        </div>
    );
}
