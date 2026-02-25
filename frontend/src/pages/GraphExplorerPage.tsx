/**
 * Graph Explorer page — main address search & graph view.
 */
import { useState, useEffect, useMemo } from "react";
import { GraphCanvas, type LayoutName, type GraphFilters } from "../components/GraphCanvas";
import { NodePanel } from "../components/NodePanel";
import { TxPanel } from "../components/TxPanel";
import { useToastContext } from "../context/ToastContext";
import type { EntityResponse, NeighborsResponse, PathResponse, TransactionResponse } from "../types";
import { fetchEntity, fetchNeighbors, fetchPaths, fetchTransaction } from "../api/client";
import { ENTITY_TYPES, RISK_LEVELS, RISK_COLOR } from "../constants";
import { Background } from "../components/Background";

interface GraphExplorerPageProps {
    initialAddress?: string | null;
    initialTxHash?: string | null;
    onAddressLoad?: () => void;
}

const DEFAULT_FILTERS: GraphFilters = {
    entityTypes: new Set(ENTITY_TYPES),
    riskLevels: new Set(RISK_LEVELS),
    addressSearch: "",
};

// shared input style used in path-finder and filter panel
const monoInput =
    "w-60 px-2.5 py-1.5 border border-gray-200 rounded-lg text-[0.75rem] font-mono bg-white text-gray-900 outline-none transition-colors focus:border-blue-400";

export function GraphExplorerPage({ initialAddress, initialTxHash, onAddressLoad }: GraphExplorerPageProps) {
    const toast = useToastContext();
    const [graphData, setGraphData] = useState<NeighborsResponse | null>(null);
    const [selectedNode, setSelectedNode] = useState<EntityResponse | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<TransactionResponse | null>(null);
    const [loading, setLoading] = useState(false);

    const [activeLayout, setActiveLayout] = useState<LayoutName>("fcose");
    const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
    const [filterPanelOpen, setFilterPanelOpen] = useState(false);

    const [pathFinderOpen, setPathFinderOpen] = useState(false);
    const [pathSource, setPathSource] = useState("");
    const [pathTarget, setPathTarget] = useState("");
    const [pathResult, setPathResult] = useState<PathResponse | null>(null);
    const [pathLoading, setPathLoading] = useState(false);

    useEffect(() => {
        if (initialAddress) {
            handleSearch(initialAddress);
            onAddressLoad?.();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialAddress]);

    useEffect(() => {
        if (initialTxHash) {
            handleTxSearch(initialTxHash);
            onAddressLoad?.();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialTxHash]);

    const handleSearch = async (address: string) => {
        setLoading(true);
        const loadId = toast.loading("Fetching graph data…");
        try {
            const [entityResult, neighborsResult] = await Promise.allSettled([
                fetchEntity(address),
                fetchNeighbors(address, { depth: 1, limit: 50 }),
            ]);

            // Tolerate 404 — synthesise a stub so the canvas can still render
            const entity: EntityResponse =
                entityResult.status === "fulfilled"
                    ? entityResult.value
                    : { address, risk_level: "unknown", labels: [], properties: {} };

            if (neighborsResult.status === "rejected") throw neighborsResult.reason;

            const neighbors = neighborsResult.value;
            setSelectedNode(entity);
            const centerInNodes = neighbors.nodes.some((n) => n.address === entity.address);
            const nodes = centerInNodes ? neighbors.nodes : [entity, ...neighbors.nodes];
            setGraphData({ ...neighbors, nodes, total_nodes: nodes.length });
            setPathResult(null);
            toast.dismiss(loadId);
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Failed to fetch data");
        } finally {
            setLoading(false);
        }
    };

    const handleTxSearch = async (hash: string) => {
        const loadId = toast.loading("Fetching transaction…");
        try {
            const tx = await fetchTransaction(hash);
            setSelectedNode(null);
            setSelectedEdge(tx);
            toast.dismiss(loadId);
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Transaction not found");
        }
    };

    const handleNodeSelect = async (address: string) => {
        setSelectedEdge(null);
        try {
            setSelectedNode(await fetchEntity(address));
        } catch {
            setSelectedNode({ address, risk_level: "unknown", labels: [], properties: {} });
        }
    };

    const handleEdgeSelect = async (txHash: string) => {
        setSelectedNode(null);
        const cached = graphData?.transactions.find((t) => t.hash === txHash) ?? null;
        if (cached) {
            setSelectedEdge(cached);
            return;
        }
        try {
            setSelectedEdge(await fetchTransaction(txHash));
        } catch {
            setSelectedEdge({ hash: txHash, from_address: "", to_address: "", properties: {} });
        }
    };

    const handleExpandNode = async (address: string) => {
        setLoading(true);
        const loadId = toast.loading("Expanding node…");
        try {
            const neighbors = await fetchNeighbors(address, { depth: 1, limit: 50 });
            if (graphData) {
                const existingAddresses = new Set(graphData.nodes.map((n) => n.address));
                const newNodes = neighbors.nodes.filter((n) => !existingAddresses.has(n.address));
                const existingTxHashes = new Set(graphData.transactions.map((t) => t.hash));
                const newTxs = neighbors.transactions.filter((t) => !existingTxHashes.has(t.hash));
                setGraphData({
                    ...graphData,
                    center_address: address,
                    nodes: [...graphData.nodes, ...newNodes],
                    transactions: [...graphData.transactions, ...newTxs],
                    total_nodes: graphData.nodes.length + newNodes.length,
                    total_transactions: graphData.transactions.length + newTxs.length,
                });
                toast.dismiss(loadId);
                if (newNodes.length > 0 || newTxs.length > 0) {
                    toast.success(`Added ${newNodes.length} entities, ${newTxs.length} transactions`);
                } else {
                    toast.info("No new neighbors found");
                }
            } else {
                setGraphData(neighbors);
                toast.dismiss(loadId);
            }
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Failed to expand node");
        } finally {
            setLoading(false);
        }
    };

    const handleFindPath = async () => {
        if (!pathSource.trim() || !pathTarget.trim()) {
            toast.error("Enter both source and target addresses");
            return;
        }
        setPathLoading(true);
        const loadId = toast.loading("Finding paths…");
        try {
            const result = await fetchPaths(pathSource.trim(), pathTarget.trim(), { maxDepth: 6, limit: 5 });
            toast.dismiss(loadId);
            if (result.total_paths === 0) {
                toast.info("No paths found between these addresses");
                setPathResult(null);
            } else {
                toast.success(`Found ${result.total_paths} path(s)`);
                setPathResult(result);
                if (graphData) {
                    const existingAddresses = new Set(graphData.nodes.map((n) => n.address));
                    const existingTxHashes = new Set(graphData.transactions.map((t) => t.hash));
                    const stubNodes: typeof graphData.nodes = [];
                    const stubTxs: typeof graphData.transactions = [];
                    result.paths.forEach((p) => {
                        p.nodes.forEach((n) => {
                            if (!existingAddresses.has(n.address)) {
                                existingAddresses.add(n.address);
                                stubNodes.push({
                                    address: n.address,
                                    entity_type: n.entity_type ?? null,
                                    name: n.name ?? null,
                                    risk_level: "unknown",
                                    labels: [],
                                    properties: {},
                                });
                            }
                        });
                        p.transactions.forEach((tx) => {
                            if (!existingTxHashes.has(tx.hash)) {
                                existingTxHashes.add(tx.hash);
                                stubTxs.push({
                                    hash: tx.hash,
                                    from_address: tx.from_address,
                                    to_address: tx.to_address,
                                    value: tx.value ?? null,
                                    block_number: tx.block_number ?? null,
                                    timestamp: null,
                                    gas_used: null,
                                    gas_price: null,
                                    properties: {},
                                });
                            }
                        });
                    });
                    if (stubNodes.length > 0 || stubTxs.length > 0) {
                        setGraphData({
                            ...graphData,
                            nodes: [...graphData.nodes, ...stubNodes],
                            transactions: [...graphData.transactions, ...stubTxs],
                            total_nodes: graphData.total_nodes + stubNodes.length,
                            total_transactions: graphData.total_transactions + stubTxs.length,
                        });
                    }
                }
            }
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Path finding failed");
        } finally {
            setPathLoading(false);
        }
    };

    const highlightedNodeIds = useMemo(() => {
        if (!pathResult) return new Set<string>();
        const ids = new Set<string>();
        pathResult.paths.forEach((p) => p.nodes.forEach((n) => ids.add(n.address)));
        return ids;
    }, [pathResult]);

    const highlightedEdgeIds = useMemo(() => {
        if (!pathResult) return new Set<string>();
        const ids = new Set<string>();
        pathResult.paths.forEach((p) => p.transactions.forEach((tx) => ids.add(`tx-${tx.hash}`)));
        return ids;
    }, [pathResult]);

    const toggleEntityType = (type: string) => {
        setFilters((prev) => {
            const next = new Set(prev.entityTypes);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return { ...prev, entityTypes: next };
        });
    };
    const toggleRiskLevel = (level: string) => {
        setFilters((prev) => {
            const next = new Set(prev.riskLevels);
            if (next.has(level)) next.delete(level);
            else next.add(level);
            return { ...prev, riskLevels: next };
        });
    };

    return (
        <div className="flex flex-col flex-1 min-h-0">
            {/* Path finder bar */}
            <div
                className={`overflow-hidden shrink-0 border-b transition-all duration-250 ${pathFinderOpen ? "h-[52px] border-gray-100" : "h-0 border-transparent"} ${pathResult ? "bg-blue-500/[0.04]" : ""}`}
            >
                <div className="flex items-center gap-2.5 px-5 h-[52px]">
                    <input
                        className={monoInput}
                        placeholder="Source address (0x…)"
                        value={pathSource}
                        onChange={(e) => setPathSource(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleFindPath()}
                    />
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth="2"
                        style={{ flexShrink: 0 }}
                    >
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                    </svg>
                    <input
                        className={monoInput}
                        placeholder="Target address (0x…)"
                        value={pathTarget}
                        onChange={(e) => setPathTarget(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleFindPath()}
                    />
                    <button
                        className="px-3.5 py-1.5 bg-gray-900 text-white text-[0.75rem] font-semibold rounded-lg border-none cursor-pointer transition-colors hover:bg-[#1e293b] disabled:opacity-45"
                        onClick={handleFindPath}
                        disabled={pathLoading}
                    >
                        {pathLoading ? "Finding…" : "Find Path"}
                    </button>
                    {pathResult && (
                        <button
                            className="px-3.5 py-1.5 bg-white text-gray-900 text-[0.75rem] font-medium rounded-lg border border-gray-200 cursor-pointer transition-colors hover:bg-gray-50"
                            onClick={() => setPathResult(null)}
                        >
                            Clear
                        </button>
                    )}
                </div>
            </div>

            {/* Main body */}
            <div className="flex flex-1 min-h-0">
                {/* Graph area */}
                <Background className="flex-1 relative overflow-hidden" useDotCube={false}>
                    {/* Loading pill */}
                    {loading && (
                        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-[5px] rounded-full bg-[rgba(15,23,42,0.75)] text-[rgba(255,255,255,0.85)] text-[0.72rem] font-medium backdrop-blur-sm border border-white/[0.08]">
                            <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none">
                                <circle
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    strokeWidth="3"
                                    strokeDasharray="40 20"
                                />
                            </svg>
                            Loading…
                        </div>
                    )}

                    {graphData ? (
                        <>
                            <GraphCanvas
                                data={graphData}
                                onNodeSelect={handleNodeSelect}
                                onNodeExpand={handleExpandNode}
                                onEdgeSelect={handleEdgeSelect}
                                selectedAddress={selectedNode?.address}
                                selectedEdgeTxHash={selectedEdge?.hash}
                                activeLayout={activeLayout}
                                onLayoutChange={setActiveLayout}
                                filters={filters}
                                highlightedNodeIds={highlightedNodeIds}
                                highlightedEdgeIds={highlightedEdgeIds}
                            />

                            {/* Filter toggle */}
                            {!filterPanelOpen && (
                                <button
                                    className="absolute top-3 left-3 z-10 w-[30px] h-[30px] flex items-center justify-center bg-[rgba(249,250,251,0.92)] border border-gray-200 rounded-lg shadow-md backdrop-blur-sm cursor-pointer text-gray-500 transition-colors p-0 hover:bg-gray-100 hover:text-gray-900"
                                    title="Toggle filters"
                                    onClick={() => setFilterPanelOpen(true)}
                                >
                                    <svg
                                        width="13"
                                        height="13"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                                    </svg>
                                </button>
                            )}

                            {/* Path finder toggle */}
                            <button
                                className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center gap-1.5 px-3 h-[30px] bg-[rgba(249,250,251,0.92)] border border-gray-200 rounded-full shadow-md backdrop-blur-sm cursor-pointer text-gray-500 text-[0.7rem] font-medium transition-colors whitespace-nowrap hover:bg-gray-100 hover:text-gray-900"
                                title="Path finder"
                                onClick={() => setPathFinderOpen((o) => !o)}
                            >
                                <svg
                                    width="13"
                                    height="13"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                                </svg>
                            </button>

                            {/* Filter panel */}
                            {filterPanelOpen && (
                                <div className="absolute top-3 left-3 z-20 w-[220px] bg-[rgba(249,250,251,0.95)] border border-gray-200 rounded-lg shadow-md backdrop-blur-sm flex flex-col overflow-hidden">
                                    <div className="flex items-center justify-between px-2.5 py-2 border-b border-gray-100">
                                        <span className="text-[0.7rem] font-semibold tracking-widest uppercase text-gray-400">
                                            Filters
                                        </span>
                                        <button
                                            className="w-[22px] h-[22px] flex items-center justify-center border border-gray-200 rounded bg-transparent cursor-pointer text-gray-500 p-0 transition-colors hover:bg-gray-100 hover:text-gray-900"
                                            onClick={() => setFilterPanelOpen(false)}
                                        >
                                            <svg
                                                width="11"
                                                height="11"
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

                                    <div className="px-2.5 py-2 flex flex-col gap-1 border-b border-gray-100 max-h-[180px] overflow-y-auto">
                                        <span className="text-[0.65rem] font-semibold tracking-widest uppercase text-gray-400 mb-1">
                                            Entity Type
                                        </span>
                                        {ENTITY_TYPES.map((type) => (
                                            <label
                                                key={type}
                                                className="flex items-center gap-1.5 text-[0.73rem] text-gray-500 cursor-pointer select-none"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={filters.entityTypes.has(type)}
                                                    onChange={() => toggleEntityType(type)}
                                                    className="mr-0"
                                                />
                                                {type}
                                            </label>
                                        ))}
                                    </div>

                                    <div className="px-2.5 py-2 flex flex-col gap-1 border-b border-gray-100 max-h-[180px] overflow-y-auto">
                                        <span className="text-[0.65rem] font-semibold tracking-widest uppercase text-gray-400 mb-1">
                                            Risk Level
                                        </span>
                                        {RISK_LEVELS.map((level) => (
                                            <label
                                                key={level}
                                                className="flex items-center gap-1.5 text-[0.73rem] text-gray-500 cursor-pointer select-none"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={filters.riskLevels.has(level)}
                                                    onChange={() => toggleRiskLevel(level)}
                                                />
                                                <span
                                                    className="w-1.5 h-1.5 rounded-full shrink-0"
                                                    style={{ background: RISK_COLOR[level] }}
                                                />
                                                {level}
                                            </label>
                                        ))}
                                    </div>

                                    <div className="px-2.5 py-2 flex flex-col gap-1 border-b border-gray-100">
                                        <span className="text-[0.65rem] font-semibold tracking-widest uppercase text-gray-400 mb-1">
                                            Address Search
                                        </span>
                                        <input
                                            type="text"
                                            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-[0.75rem] font-mono bg-white text-gray-900 outline-none focus:border-blue-400"
                                            placeholder="0x… or name"
                                            value={filters.addressSearch}
                                            onChange={(e) =>
                                                setFilters((prev) => ({ ...prev, addressSearch: e.target.value }))
                                            }
                                        />
                                    </div>

                                    <div className="px-2.5 py-2.5">
                                        <button
                                            className="w-full px-2.5 py-[5px] text-[0.72rem] font-medium bg-white border border-gray-200 rounded-lg text-gray-900 cursor-pointer transition-colors hover:bg-gray-50"
                                            onClick={() => setFilters(DEFAULT_FILTERS)}
                                        >
                                            Reset filters
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Stats bar */}
                            <div className="absolute bottom-5 left-5 z-10 flex gap-2">
                                <span className="inline-flex items-center gap-[5px] px-2.5 py-[5px] bg-[rgba(249,250,251,0.9)] border border-gray-200 backdrop-blur-sm rounded-full text-[0.7rem] font-medium text-gray-500">
                                    <span className="w-[5px] h-[5px] rounded-full bg-blue-500" />
                                    {graphData.total_nodes} entities
                                </span>
                                <span className="inline-flex items-center gap-[5px] px-2.5 py-[5px] bg-[rgba(249,250,251,0.9)] border border-gray-200 backdrop-blur-sm rounded-full text-[0.7rem] font-medium text-gray-500">
                                    <span className="w-[5px] h-[5px] rounded-full bg-emerald-500" />
                                    {graphData.total_transactions} transactions
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-6 p-10">
                            <div className="w-16 h-16 rounded-2xl border border-gray-200 bg-white shadow-sm flex items-center justify-center text-gray-400">
                                <svg
                                    width="28"
                                    height="28"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                >
                                    <circle cx="12" cy="12" r="3" />
                                    <circle cx="4" cy="6" r="2" />
                                    <circle cx="20" cy="6" r="2" />
                                    <circle cx="4" cy="18" r="2" />
                                    <circle cx="20" cy="18" r="2" />
                                    <line x1="12" y1="12" x2="4" y2="6" />
                                    <line x1="12" y1="12" x2="20" y2="6" />
                                    <line x1="12" y1="12" x2="4" y2="18" />
                                    <line x1="12" y1="12" x2="20" y2="18" />
                                </svg>
                            </div>
                            <div className="text-center">
                                <p className="text-[1.1rem] font-semibold text-gray-900 tracking-[-0.01em]">
                                    Transaction Graph Explorer.
                                </p>
                                <p className="text-[0.8rem] text-gray-400 text-center mt-2">
                                    Enter an Ethereum address to map its on-chain relationships
                                    <br />
                                    and trace fund flows across the network.
                                </p>
                            </div>
                            <button
                                className="inline-flex items-center gap-2 px-3.5 py-2 bg-white border border-gray-200 rounded-lg text-[0.75rem] text-gray-500 shadow-[0_1px_2px_rgba(15,23,42,0.05)] cursor-pointer transition-colors font-mono hover:bg-gray-50 hover:border-gray-300"
                                onClick={() => handleSearch("0x28c6c06298d514db089934071355e5743bf21d60")}
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                                Try Binance: 0x28c6…1d60
                            </button>
                        </div>
                    )}
                </Background>

                {/* Side panel */}
                {(selectedNode || selectedEdge) && (
                    <aside className="w-[340px] bg-white border-l border-gray-200 flex flex-col overflow-hidden shadow-[-4px_0_20px_rgba(15,23,42,0.04)] animate-[slide-in_250ms_cubic-bezier(0.4,0,0.2,1)]">
                        {selectedNode && (
                            <NodePanel
                                node={selectedNode}
                                onExpand={() => handleExpandNode(selectedNode.address)}
                                onClose={() => setSelectedNode(null)}
                                transactions={graphData?.transactions}
                                onNavigateToAddress={handleNodeSelect}
                            />
                        )}
                        {selectedEdge && (
                            <TxPanel
                                tx={selectedEdge}
                                onClose={() => setSelectedEdge(null)}
                                onNavigateToAddress={handleNodeSelect}
                                onExploreAddress={handleSearch}
                            />
                        )}
                    </aside>
                )}
            </div>
        </div>
    );
}
