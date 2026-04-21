/**
 * ETL Page — test and manage the backend ETL pipeline.
 */
import { useState, useCallback, useRef } from "react";
import { useHealth } from "../hooks/useHealth";
import { useGraphStats } from "../hooks/useGraphStats";
import { useToastContext } from "../context/ToastContext";
import { useIngestionRun } from "../hooks/useIngestionRun";
import { useIngestionRuns } from "../context/IngestionRunsContext";
import {
    fetchEntity,
    fetchNeighbors,
    fetchTransaction,
    upsertEntity,
    updateEntity,
    deleteEntity,
    upsertTransaction,
    deleteTransaction,
    ingestAddress,
    formatAddress,
    formatWei,
    type TransactionUpsertRequest,
} from "../api/client";
import { parseTxImportFile, type ParsedTxRow } from "../utils/txImportParser";
import type { EntityResponse, EntityType, NeighborsResponse, RiskLevel, TransactionResponse } from "../types";
import {
    ENTITY_TYPES,
    RISK_LEVELS,
    inputCls,
    monoCls,
    selectCls,
    btnPrimary,
    btnSecondary,
    btnDanger,
    sectionLabel,
    propsBlock,
} from "../constants";

function isValidAddress(addr: string) {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

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
    const {
        stats,
        loading: statsLoading,
        error: statsError,
        refresh: refreshStats,
    } = useGraphStats({ refreshInterval: 10000 });

    const [searchAddress, setSearchAddress] = useState("");
    const [searchLoading, setSearchLoading] = useState(false);
    const [entityResult, setEntityResult] = useState<EntityResponse | null>(null);
    const [neighborsResult, setNeighborsResult] = useState<NeighborsResponse | null>(null);

    const [txLookupHash, setTxLookupHash] = useState("");
    const [txLookupSourceAddr, setTxLookupSourceAddr] = useState("");
    const [txLookupLoading, setTxLookupLoading] = useState(false);
    const [txLookupResult, setTxLookupResult] = useState<TransactionResponse | null>(null);

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
    const [txFromAddr, setTxFromAddr] = useState("");
    const [txToAddr, setTxToAddr] = useState("");
    const [txValue, setTxValue] = useState("");
    const [txBlock, setTxBlock] = useState("");
    const [txLoading, setTxLoading] = useState(false);
    const [txResult, setTxResult] = useState<TransactionResponse | null>(null);

    const [deleteTxHash, setDeleteTxHash] = useState("");
    const [deleteTxLoading, setDeleteTxLoading] = useState(false);

    // ── Bulk import state ────────────────────────────────────────────────────
    const [importRows, setImportRows] = useState<ParsedTxRow[]>([]);
    const [importFileName, setImportFileName] = useState("");
    const [importDragOver, setImportDragOver] = useState(false);
    const [importRunning, setImportRunning] = useState(false);
    const [importDone, setImportDone] = useState(false);
    const [importProgress, setImportProgress] = useState(0);
    // Per-row import status: undefined=pending, "ok"=success, string=error message
    const [importStatuses, setImportStatuses] = useState<("ok" | string | undefined)[]>([]);
    const importCancelledRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Ingest address state ─────────────────────────────────────────────────
    const [ingestAddr, setIngestAddr] = useState("");
    const [ingestLoading, setIngestLoading] = useState(false);
    const [ingestRunId, setIngestRunId] = useState<string | null>(null);
    const ingestRun = useIngestionRun(ingestRunId, {
        onComplete: (run) => {
            if (run.status === "completed") {
                refreshStats();
            }
        },
    });
    const { track: trackRun } = useIngestionRuns();

    const overallHealthy = health?.status === "healthy";

    const handleIngestAddress = async () => {
        const addr = ingestAddr.trim().toLowerCase();
        if (!isValidAddress(addr)) {
            toast.error("Must be 0x followed by 40 hex characters.");
            return;
        }
        setIngestLoading(true);
        setIngestRunId(null);
        try {
            const result = await ingestAddress({ address: addr });
            setIngestRunId(result.run_id);
            trackRun(result.run_id, {
                onComplete: (run) => {
                    if (run.status === "completed") {
                        toast.success(`Ingest complete — ${run.transactions_processed} txs`);
                        refreshStats();
                    } else {
                        toast.error(`Ingest failed${run.error_message ? `: ${run.error_message}` : ""}`);
                    }
                },
            });
            toast.success("Queued — follow progress in the run pill");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Ingestion failed");
        } finally {
            setIngestLoading(false);
        }
    };

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

    const handleTxLookup = async () => {
        const hash = txLookupHash.trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
            toast.error("Hash must be 0x followed by 64 hex characters.");
            return;
        }
        setTxLookupLoading(true);
        setTxLookupResult(null);
        const id = toast.loading("Looking up transaction…");
        try {
            const result = await fetchTransaction(hash);
            setTxLookupResult(result);
            toast.dismiss(id);
            toast.success(`Found: ${hash.slice(0, 10)}…`);
        } catch (err: any) {
            toast.dismiss(id);
            if (err?.status === 404) {
                const addrToIngest =
                    (isValidAddress(txLookupSourceAddr.trim().toLowerCase()) ? txLookupSourceAddr.trim().toLowerCase() : null) ||
                    entityResult?.address ||
                    (isValidAddress(searchAddress.trim().toLowerCase()) ? searchAddress.trim().toLowerCase() : null);
                if (addrToIngest) {
                    try {
                        const queued = await ingestAddress({ address: addrToIngest });
                        toast.success(`Queued ingest of ${addrToIngest.slice(0, 10)}…`);
                        trackRun(queued.run_id, {
                            onComplete: async (run) => {
                                if (run.status !== "completed") {
                                    toast.error(`Ingest failed${run.error_message ? `: ${run.error_message}` : ""}`);
                                    return;
                                }
                                try {
                                    const result = await fetchTransaction(hash);
                                    setTxLookupResult(result);
                                    toast.success(`Found after ingestion: ${hash.slice(0, 10)}…`);
                                } catch {
                                    toast.error("Ingest succeeded but transaction still not found");
                                }
                            },
                        });
                    } catch (ingestErr: any) {
                        toast.error(ingestErr?.message || "Failed to queue ingest");
                    }
                } else {
                    toast.error("Transaction not found. Enter a source address below to auto-ingest.");
                }
            } else {
                toast.error(err instanceof Error ? err.message : "Request failed");
            }
        } finally {
            setTxLookupLoading(false);
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

    const handleTxUpsert = async () => {
        const hash = txHash.trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
            toast.error("Hash must be 0x followed by 64 hex characters.");
            return;
        }
        if (!isValidAddress(txFromAddr.trim().toLowerCase())) {
            toast.error("Invalid from_address format.");
            return;
        }
        if (!isValidAddress(txToAddr.trim().toLowerCase())) {
            toast.error("Invalid to_address format.");
            return;
        }
        setTxLoading(true);
        setTxResult(null);
        const id = toast.loading("Upserting transaction…");
        try {
            // Convert ETH input to wei string for storage (1 ETH = 1e18 wei)
            let valueWei: string | undefined;
            if (txValue.trim()) {
                const ethFloat = parseFloat(txValue.trim());
                if (isNaN(ethFloat) || ethFloat < 0) {
                    toast.dismiss(id);
                    toast.error("Value must be a non-negative number in ETH.");
                    setTxLoading(false);
                    return;
                }
                valueWei = BigInt(Math.round(ethFloat * 1e18)).toString();
            }
            const body: TransactionUpsertRequest = {
                from_address: txFromAddr.trim().toLowerCase(),
                to_address: txToAddr.trim().toLowerCase(),
                ...(valueWei !== undefined && { value: valueWei }),
                ...(txBlock.trim() && { block_number: parseInt(txBlock.trim(), 10) }),
            };
            const result = await upsertTransaction(hash, body);
            setTxResult(result);
            toast.dismiss(id);
            toast.success(`Upserted tx: ${hash.slice(0, 10)}…`);
            refreshStats();
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setTxLoading(false);
        }
    };

    const handleTxDelete = async () => {
        const hash = deleteTxHash.trim();
        if (!hash) return;
        setDeleteTxLoading(true);
        const id = toast.loading("Deleting transaction…");
        try {
            await deleteTransaction(hash);
            toast.dismiss(id);
            toast.success(`Deleted tx: ${hash.slice(0, 10)}…`);
            setDeleteTxHash("");
            refreshStats();
        } catch (err) {
            toast.dismiss(id);
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setDeleteTxLoading(false);
        }
    };

    // ── Bulk import handlers ─────────────────────────────────────────────────

    const handleFilePick = useCallback(async (file: File) => {
        setImportDone(false);
        setImportProgress(0);
        setImportStatuses([]);
        setImportFileName(file.name);
        try {
            const rows = await parseTxImportFile(file);
            if (rows.length === 0) {
                toast.error("File contains no rows.");
                return;
            }
            setImportRows(rows);
            setImportStatuses(new Array(rows.length).fill(undefined));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to parse file");
        }
    }, [toast]);

    const handleImport = async () => {
        const validRows = importRows.filter((r) => r.valid);
        if (validRows.length === 0) {
            toast.error("No valid rows to import.");
            return;
        }
        importCancelledRef.current = false;
        setImportRunning(true);
        setImportDone(false);
        setImportProgress(0);
        // Reset all statuses
        setImportStatuses(new Array(importRows.length).fill(undefined));

        let done = 0;
        for (const row of validRows) {
            if (importCancelledRef.current) break;
            const body: TransactionUpsertRequest = {
                from_address: row.from_address,
                to_address: row.to_address,
                ...(row.value !== undefined && { value: row.value }),
                ...(row.block_number !== undefined && { block_number: row.block_number }),
                ...(row.timestamp && { timestamp: row.timestamp }),
                ...(row.gas_used !== undefined && { gas_used: row.gas_used }),
                ...(row.gas_price && { gas_price: row.gas_price }),
            };
            try {
                await upsertTransaction(row.hash, body);
                setImportStatuses((prev) => {
                    const next = [...prev];
                    next[row.index] = "ok";
                    return next;
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Request failed";
                setImportStatuses((prev) => {
                    const next = [...prev];
                    next[row.index] = msg;
                    return next;
                });
            }
            done++;
            setImportProgress(done);
        }
        setImportRunning(false);
        setImportDone(true);
        refreshStats();
    };

    const handleCancelImport = () => {
        importCancelledRef.current = true;
    };

    const handleResetImport = () => {
        setImportRows([]);
        setImportFileName("");
        setImportStatuses([]);
        setImportProgress(0);
        setImportDone(false);
        importCancelledRef.current = false;
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
                    <div
                        className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg border mb-5 ${overallHealthy ? "border-green-200/60 bg-green-500/[0.06]" : "border-yellow-200/60 bg-yellow-500/[0.06]"}`}
                    >
                        <span
                            className={`w-2 h-2 rounded-full shrink-0 ${overallHealthy ? "bg-green-500" : "bg-yellow-500"}`}
                        />
                        <span className="text-[0.8rem] font-semibold text-gray-900">
                            {overallHealthy ? "Backend Connected" : "Backend Degraded"}
                        </span>
                        <span className="ml-auto text-[0.7rem] text-gray-400">
                            {Object.entries(health.services)
                                .filter(([, v]) => v)
                                .map(([k]) => k)
                                .join(", ")}
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
                                    {
                                        v: (stats.risk_levels["high"] || 0) + (stats.risk_levels["critical"] || 0),
                                        l: "High Risk",
                                    },
                                ].map(({ v, l }) => (
                                    <div key={l}>
                                        <div className="text-[1.4rem] font-bold text-gray-900 tracking-[-0.02em] leading-none">
                                            {v}
                                        </div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">{l}</div>
                                    </div>
                                ))}
                            </div>
                            {Object.keys(stats.entity_types).length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-3">
                                    {Object.entries(stats.entity_types).map(([type, count]) => (
                                        <span
                                            key={type}
                                            className="px-2 py-[3px] bg-gray-50 border border-gray-200 rounded text-[0.7rem] text-gray-500"
                                        >
                                            {type}: {count}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        !statsLoading && (
                            <p className="text-[0.78rem] text-gray-400">No graph data. Run the ETL pipeline first.</p>
                        )
                    )}
                </div>

                {/* Ingest Address from Etherscan */}
                <Section title="Ingest Address from Etherscan">
                    <p className="text-[0.75rem] text-gray-500 mb-3">
                        Fetch all transactions for an address from Etherscan and import entities + transactions into Neo4j and PostgreSQL.
                    </p>
                    <div className="flex gap-2">
                        <input
                            value={ingestAddr}
                            onChange={(e) => setIngestAddr(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleIngestAddress()}
                            placeholder="0x… address to ingest"
                            className={monoCls}
                        />
                        <button
                            onClick={handleIngestAddress}
                            disabled={ingestLoading || !ingestAddr.trim()}
                            className={btnPrimary}
                        >
                            {ingestLoading ? "Ingesting…" : "Ingest"}
                        </button>
                    </div>
                    {ingestRun && (
                        <div
                            className={`mt-3 p-3 border rounded-lg ${
                                ingestRun.status === "completed"
                                    ? "border-green-200 bg-green-50"
                                    : ingestRun.status === "failed"
                                      ? "border-rose-200 bg-rose-50"
                                      : "border-sky-200 bg-sky-50"
                            }`}
                        >
                            <p
                                className={`text-[0.78rem] font-semibold mb-2 uppercase tracking-wide ${
                                    ingestRun.status === "completed"
                                        ? "text-green-700"
                                        : ingestRun.status === "failed"
                                          ? "text-rose-700"
                                          : "text-sky-700"
                                }`}
                            >
                                Run {ingestRun.status}
                            </p>
                            <div className="grid grid-cols-3 gap-3">
                                {[
                                    { v: ingestRun.transactions_processed, l: "Txs Processed" },
                                    { v: ingestRun.traces_processed, l: "Traces" },
                                    { v: ingestRun.nodes_created, l: "Nodes Created" },
                                ].map(({ v, l }) => (
                                    <div key={l}>
                                        <div className="text-[1rem] font-bold text-gray-900 leading-none">{v}</div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">{l}</div>
                                    </div>
                                ))}
                            </div>
                            {ingestRun.error_message && (
                                <p className="text-[0.72rem] text-rose-700 mt-2">{ingestRun.error_message}</p>
                            )}
                            <p className="font-mono text-[0.68rem] text-gray-500 mt-2">
                                Run ID: {ingestRun.run_id}
                            </p>
                        </div>
                    )}
                </Section>

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
                        <button
                            onClick={handleSearch}
                            disabled={searchLoading || !searchAddress.trim()}
                            className={btnPrimary}
                        >
                            {searchLoading ? "…" : "Search"}
                        </button>
                    </div>

                    {entityResult && (
                        <div className="mt-3 p-3 border border-gray-200 rounded-lg bg-gray-50">
                            <div className="flex items-center gap-2 mb-2">
                                <span
                                    className={`inline-flex items-center px-2 py-[3px] rounded text-[0.65rem] font-semibold uppercase ${{
                                            unknown: "bg-slate-100 text-slate-500",
                                            low: "bg-green-100 text-green-700",
                                            medium: "bg-yellow-100 text-yellow-700",
                                            high: "bg-orange-100 text-orange-700",
                                            critical: "bg-red-100 text-red-700",
                                        }[entityResult.risk_level]
                                        }`}
                                >
                                    {entityResult.risk_level}
                                </span>
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
                                        <span
                                            key={l}
                                            className="px-2 py-[3px] bg-white border border-gray-200 rounded text-[0.7rem] text-gray-500"
                                        >
                                            {l}
                                        </span>
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
                                    <div className={propsBlock}>
                                        <pre className="m-0 font-mono">
                                            {JSON.stringify(entityResult.properties, null, 2)}
                                        </pre>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {neighborsResult && neighborsResult.nodes.length > 0 && (
                        <div className="mt-3">
                            <p className={`${sectionLabel} mb-2`}>
                                Neighbors — {neighborsResult.total_nodes} entities, {neighborsResult.total_transactions}{" "}
                                transactions
                            </p>
                            <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                                {neighborsResult.nodes.slice(0, 10).map((node) => (
                                    <button
                                        key={node.address}
                                        onClick={() => setSearchAddress(node.address)}
                                        className="flex flex-col gap-0.5 px-2.5 py-1.5 border border-gray-200 rounded-lg bg-white text-left cursor-pointer transition-colors hover:bg-gray-50"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <span
                                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                                style={{ background: `var(--risk-${node.risk_level})` }}
                                            />
                                            <span className="font-mono text-[0.7rem] text-gray-700">
                                                {formatAddress(node.address, 6)}
                                            </span>
                                        </div>
                                        {node.entity_type && (
                                            <span className="text-[0.65rem] text-gray-400">{node.entity_type}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                            {neighborsResult.nodes.length > 10 && (
                                <p className="text-[0.7rem] text-gray-400 mt-1.5">
                                    Showing 10 of {neighborsResult.nodes.length}
                                </p>
                            )}
                        </div>
                    )}
                </Section>

                {/* Lookup Transaction */}
                <Section title="Lookup Transaction">
                    <div className="flex gap-2">
                        <input
                            value={txLookupHash}
                            onChange={(e) => setTxLookupHash(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleTxLookup()}
                            placeholder="0x… transaction hash (66 chars)"
                            className={monoCls}
                        />
                        <button
                            onClick={handleTxLookup}
                            disabled={txLookupLoading || !txLookupHash.trim()}
                            className={btnPrimary}
                        >
                            {txLookupLoading ? "…" : "Search"}
                        </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                        <input
                            value={txLookupSourceAddr}
                            onChange={(e) => setTxLookupSourceAddr(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleTxLookup()}
                            placeholder="Source address to auto-ingest if tx not found (optional)"
                            className={monoCls}
                        />
                    </div>
                    {txLookupResult && (
                        <div className="mt-3 p-3 border border-gray-200 rounded-lg">
                            {/* Value stat */}
                            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5">
                                <div className="flex flex-col">
                                    <span className="text-[0.68rem] font-medium uppercase tracking-[0.14em] text-gray-500">
                                        Value transferred
                                    </span>
                                    <span className="mt-1 font-mono text-[0.9rem] font-semibold text-gray-900 leading-none">
                                        {formatWei(txLookupResult.value)}
                                    </span>
                                </div>
                                <a
                                    href={`/explorer?tx=${encodeURIComponent(txLookupResult.hash)}`}
                                    className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-[7px] text-[0.76rem] font-semibold text-gray-900 hover:bg-gray-50 transition-colors"
                                >
                                    Open in Explorer
                                </a>
                            </div>
                            {/* FROM / TO address cards */}
                            <div className="flex flex-col gap-1.5 mb-3">
                                {[
                                    { badge: "FROM", addr: txLookupResult.from_address },
                                    { badge: "TO", addr: txLookupResult.to_address },
                                ].map(({ badge, addr }) => (
                                    <div
                                        key={badge}
                                        className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg"
                                    >
                                        <span
                                            className={`inline-flex w-12 items-center justify-center px-1.5 py-[2px] rounded text-[0.6rem] font-bold tracking-widest uppercase shrink-0 text-slate-500`}
                                        >
                                            {badge}
                                        </span>
                                        <span className="font-mono text-[0.72rem] text-gray-700 truncate" title={addr}>
                                            {addr}
                                        </span>
                                    </div>
                                ))}
                            </div>
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
                                    className={
                                        upsertMode === m
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
                        <input
                            value={upsertAddr}
                            onChange={(e) => setUpsertAddr(e.target.value)}
                            placeholder="0x… address"
                            className={monoCls}
                        />
                        <div className="flex gap-2">
                            <select
                                value={upsertType}
                                onChange={(e) => setUpsertType(e.target.value as EntityType)}
                                className={selectCls}
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
                                className={selectCls}
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
                                className={inputCls}
                            />
                        </div>
                    </div>
                    <div className="mt-2.5">
                        <button
                            onClick={handleNodeUpsert}
                            disabled={upsertLoading || !upsertAddr.trim()}
                            className={btnPrimary}
                        >
                            {upsertLoading ? "…" : upsertMode === "put" ? "PUT Node" : "PATCH Node"}
                        </button>
                    </div>
                    {upsertResult && (
                        <div className="mt-2.5">
                            <p className={`${sectionLabel} mb-1.5`}>Result</p>
                            <div className={propsBlock}>
                                <pre className="m-0 font-mono">{JSON.stringify(upsertResult, null, 2)}</pre>
                            </div>
                        </div>
                    )}
                </Section>

                {/* Import Transactions */}
                <Section title="Import Transactions (JSON / CSV)">
                    {/* hidden file input */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,.csv,application/json,text/csv"
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleFilePick(f);
                            // reset so same file can be re-picked
                            e.target.value = "";
                        }}
                    />

                    {importRows.length === 0 ? (
                        /* ── Stage 1: Drop zone ─────────────────────────── */
                        <div
                            className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl px-6 py-10 transition-colors cursor-pointer select-none ${importDragOver
                                    ? "border-blue-400 bg-blue-50"
                                    : "border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-gray-100"
                                }`}
                            onDragOver={(e) => { e.preventDefault(); setImportDragOver(true); }}
                            onDragLeave={() => setImportDragOver(false)}
                            onDrop={(e) => {
                                e.preventDefault();
                                setImportDragOver(false);
                                const f = e.dataTransfer.files?.[0];
                                if (f) handleFilePick(f);
                            }}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5">
                                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            <div className="text-center">
                                <p className="text-[0.85rem] font-semibold text-gray-700">
                                    Drop a <code className="font-mono">.json</code> or <code className="font-mono">.csv</code> file here
                                </p>
                                <p className="text-[0.72rem] text-gray-400 mt-0.5">
                                    or click to browse
                                </p>
                            </div>
                            <button
                                className={btnSecondary}
                                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                            >
                                Choose File
                            </button>
                            <p className="text-[0.68rem] text-gray-400 text-center max-w-xs">
                                Required fields: <code className="font-mono">hash</code>,{" "}
                                <code className="font-mono">from_address</code>,{" "}
                                <code className="font-mono">to_address</code>.
                                Optional: <code className="font-mono">value</code> (ETH or wei),{" "}
                                <code className="font-mono">block_number</code>,{" "}
                                <code className="font-mono">timestamp</code>,{" "}
                                <code className="font-mono">gas_used</code>,{" "}
                                <code className="font-mono">gas_price</code>.
                            </p>
                        </div>
                    ) : (
                        /* ── Stage 2 / 3 / 4: Preview + progress ──────────── */
                        <div className="flex flex-col gap-3">
                            {/* File name + summary bar */}
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                                        <polyline points="14 2 14 8 20 8" />
                                    </svg>
                                    <span className="text-[0.78rem] font-semibold text-gray-700 truncate max-w-[200px]">
                                        {importFileName}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <span className="text-[0.72rem] text-green-600 font-semibold">
                                        {importRows.filter((r) => r.valid).length} valid
                                    </span>
                                    {importRows.some((r) => !r.valid) && (
                                        <span className="text-[0.72rem] text-red-500 font-semibold">
                                            · {importRows.filter((r) => !r.valid).length} invalid
                                        </span>
                                    )}
                                    {!importRunning && (
                                        <button className={btnSecondary} onClick={handleResetImport}>
                                            Clear
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Progress bar (shown while running) */}
                            {importRunning && (
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[0.72rem] text-gray-500">
                                            Importing… {importProgress} / {importRows.filter((r) => r.valid).length}
                                        </span>
                                        <button
                                            className="text-[0.7rem] text-red-500 font-semibold hover:underline"
                                            onClick={handleCancelImport}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-blue-500 rounded-full transition-all duration-200"
                                            style={{
                                                width: `${Math.round(
                                                    (importProgress / Math.max(1, importRows.filter((r) => r.valid).length)) * 100
                                                )}%`,
                                            }}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Done summary */}
                            {importDone && !importRunning && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border border-green-200">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                    <span className="text-[0.78rem] text-green-700 font-semibold">
                                        Done —{" "}
                                        {importStatuses.filter((s) => s === "ok").length} succeeded,{" "}
                                        {importStatuses.filter((s) => s !== undefined && s !== "ok").length} failed
                                    </span>
                                    <button
                                        className="ml-auto text-[0.7rem] text-green-600 font-semibold hover:underline"
                                        onClick={handleResetImport}
                                    >
                                        Import another file
                                    </button>
                                </div>
                            )}

                            {/* Preview table */}
                            <div className="overflow-x-auto rounded-lg border border-gray-200">
                                <table className="w-full text-[0.7rem] border-collapse">
                                    <thead>
                                        <tr className="bg-gray-50 border-b border-gray-200">
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500 w-8">#</th>
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Hash</th>
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500">From</th>
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500">To</th>
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Value</th>
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Block</th>
                                            <th className="px-2 py-1.5 text-left font-semibold text-gray-500 w-20">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {importRows.map((row) => {
                                            const status = importStatuses[row.index];
                                            const rowBg = !row.valid
                                                ? "bg-red-50"
                                                : status === "ok"
                                                    ? "bg-green-50"
                                                    : status !== undefined
                                                        ? "bg-red-50"
                                                        : "bg-white";
                                            return (
                                                <tr
                                                    key={row.index}
                                                    className={`border-b border-gray-100 last:border-0 ${rowBg}`}
                                                >
                                                    <td className="px-2 py-1.5 text-gray-400">{row.index + 1}</td>
                                                    <td className="px-2 py-1.5 font-mono text-gray-700 whitespace-nowrap">
                                                        {row.hash ? `${row.hash.slice(0, 8)}…${row.hash.slice(-4)}` : <span className="text-red-400">—</span>}
                                                    </td>
                                                    <td className="px-2 py-1.5 font-mono text-gray-600 whitespace-nowrap">
                                                        {row.from_address ? formatAddress(row.from_address, 4) : <span className="text-red-400">—</span>}
                                                    </td>
                                                    <td className="px-2 py-1.5 font-mono text-gray-600 whitespace-nowrap">
                                                        {row.to_address ? formatAddress(row.to_address, 4) : <span className="text-red-400">—</span>}
                                                    </td>
                                                    <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">
                                                        {row.value ? formatWei(row.value) : "—"}
                                                    </td>
                                                    <td className="px-2 py-1.5 text-gray-500">
                                                        {row.block_number?.toLocaleString() ?? "—"}
                                                    </td>
                                                    <td className="px-2 py-1.5">
                                                        {!row.valid ? (
                                                            <span
                                                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-semibold bg-red-100 text-red-600"
                                                                title={row.errors.join(" · ")}
                                                            >
                                                                ✗ Invalid
                                                            </span>
                                                        ) : status === "ok" ? (
                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-semibold bg-green-100 text-green-700">
                                                                ✓ OK
                                                            </span>
                                                        ) : status !== undefined ? (
                                                            <span
                                                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-semibold bg-red-100 text-red-600"
                                                                title={status}
                                                            >
                                                                ✗ Error
                                                            </span>
                                                        ) : importRunning ? (
                                                            <span className="text-gray-300 text-[0.6rem]">…</span>
                                                        ) : (
                                                            <span className="text-gray-300 text-[0.6rem]">—</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {/* Action buttons */}
                            {!importRunning && !importDone && (
                                <div className="flex gap-2">
                                    <button
                                        className={btnPrimary}
                                        disabled={importRows.filter((r) => r.valid).length === 0}
                                        onClick={handleImport}
                                    >
                                        Import {importRows.filter((r) => r.valid).length} valid row{importRows.filter((r) => r.valid).length !== 1 ? "s" : ""}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </Section>

                {/* Upsert Transaction */}
                <Section title="Upsert Transaction">
                    <div className="flex flex-col gap-2">
                        <input
                            value={txHash}
                            onChange={(e) => setTxHash(e.target.value)}
                            placeholder="0x… transaction hash (66 chars)"
                            className={monoCls}
                        />
                        <div className="flex gap-2">
                            <input
                                value={txFromAddr}
                                onChange={(e) => setTxFromAddr(e.target.value)}
                                placeholder="from_address (0x…)"
                                className={`${monoCls} flex-1`}
                            />
                            <input
                                value={txToAddr}
                                onChange={(e) => setTxToAddr(e.target.value)}
                                placeholder="to_address (0x…)"
                                className={`${monoCls} flex-1`}
                            />
                        </div>
                        <div className="flex gap-2">
                            <input
                                value={txValue}
                                onChange={(e) => setTxValue(e.target.value)}
                                placeholder="value in ETH (optional)"
                                className={inputCls}
                            />
                            <input
                                value={txBlock}
                                onChange={(e) => setTxBlock(e.target.value)}
                                placeholder="block number (optional)"
                                className={inputCls}
                            />
                        </div>
                    </div>
                    <div className="mt-2.5">
                        <button
                            onClick={handleTxUpsert}
                            disabled={txLoading || !txHash.trim() || !txFromAddr.trim() || !txToAddr.trim()}
                            className={btnPrimary}
                        >
                            {txLoading ? "…" : "PUT Transaction"}
                        </button>
                    </div>
                    {txResult && (
                        <div className="mt-2.5">
                            <p className={`${sectionLabel} mb-1.5`}>Result</p>
                            <div className={propsBlock}>
                                <pre className="m-0 font-mono">{JSON.stringify(txResult, null, 2)}</pre>
                            </div>
                        </div>
                    )}
                </Section>

                {/* Delete Transaction */}
                <Section title="Delete Transaction">
                    <div className="flex gap-2">
                        <input
                            value={deleteTxHash}
                            onChange={(e) => setDeleteTxHash(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleTxDelete()}
                            placeholder="0x… transaction hash to delete"
                            className={monoCls}
                        />
                        <button
                            onClick={handleTxDelete}
                            disabled={deleteTxLoading || !deleteTxHash.trim()}
                            className={btnDanger}
                        >
                            {deleteTxLoading ? "…" : "Delete"}
                        </button>
                    </div>
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
                        <button
                            onClick={handleNodeDelete}
                            disabled={deleteLoading || !deleteAddr.trim()}
                            className={btnDanger}
                        >
                            {deleteLoading ? "…" : "Delete"}
                        </button>
                    </div>
                </Section>

                {/* Instructions */}
                <Section title="Testing Instructions">
                    <div className="p-3.5 border border-gray-200 rounded-lg bg-gray-50 text-[0.78rem] leading-[1.7] text-gray-600">
                        <ol className="m-0 pl-[18px]">
                            <li className="mb-1.5">
                                Start infrastructure: <code className="font-mono">docker compose up -d</code>
                            </li>
                            <li className="mb-1.5">
                                Start Dagster: <code className="font-mono">dagster dev -f src/etl/definitions.py</code>
                            </li>
                            <li className="mb-1.5">
                                Materialize assets:{" "}
                                <code className="font-mono">{`{start_block: 18000000, end_block: 18000010}`}</code>
                            </li>
                            <li className="mb-1.5">Refresh stats → verify entity / transaction counts increased</li>
                            <li className="mb-1.5">
                                Use <strong>Lookup</strong> to confirm addresses exist in Neo4j
                            </li>
                            <li className="mb-1.5">
                                Use <strong>PUT Node</strong> to create a test entity; <strong>PATCH Node</strong> to
                                update it
                            </li>
                            <li>
                                Use the Graph Explorer to verify transaction nodes and neighbors are correctly linked
                                via SENT/RECEIVED relationships
                            </li>
                        </ol>
                    </div>
                </Section>
            </div>
        </div>
    );
}
