/**
 * Graph Explorer page — main address search & graph view.
 */
import { useState, useEffect, useMemo } from "react";
import { GraphCanvas, type LayoutName, type GraphFilters } from "../components/GraphCanvas";
import { NodePanel } from "../components/NodePanel";
import { EdgePanel } from "../components/EdgePanel";
import { useToastContext } from "../context/ToastContext";
import type { EntityResponse, NeighborsResponse, PathResponse, TransactionResponse } from "../types";
import { fetchEntity, fetchNeighbors, fetchPaths, fetchTransaction } from "../api/client";

interface GraphExplorerPageProps {
    initialAddress?: string | null;
    onAddressLoad?: () => void;
}

const ALL_ENTITY_TYPES = [
    "EOA", "Contract", "Mixer", "DEX", "CEXHotWallet",
    "Bridge", "LendingPool", "Application", "Unknown",
];
const ALL_RISK_LEVELS = ["unknown", "low", "medium", "high", "critical"];
const DEFAULT_FILTERS: GraphFilters = {
    entityTypes: new Set(ALL_ENTITY_TYPES),
    riskLevels: new Set(ALL_RISK_LEVELS),
    addressSearch: "",
};

const RISK_DOT_COLORS: Record<string, string> = {
    unknown: "#94a3b8",
    low: "#22c55e",
    medium: "#eab308",
    high: "#f97316",
    critical: "#ef4444",
};

export function GraphExplorerPage({ initialAddress, onAddressLoad }: GraphExplorerPageProps) {
    const toast = useToastContext();
    const [graphData, setGraphData] = useState<NeighborsResponse | null>(null);
    const [selectedNode, setSelectedNode] = useState<EntityResponse | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<TransactionResponse | null>(null);
    const [loading, setLoading] = useState(false);

    // Layout & filter state
    const [activeLayout, setActiveLayout] = useState<LayoutName>("fcose");
    const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
    const [filterPanelOpen, setFilterPanelOpen] = useState(false);

    // Path finder state
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

    const handleSearch = async (address: string) => {
        setLoading(true);
        const loadId = toast.loading("Fetching graph data…");
        try {
            const [entity, neighbors] = await Promise.all([
                fetchEntity(address),
                fetchNeighbors(address, { depth: 1, limit: 50 }),
            ]);
            setSelectedNode(entity);

            // Ensure the center node is always in the graph even if it has no
            // SENT/RECEIVED transactions (e.g. a group node with only MEMBER_OF edges).
            const centerInNodes = neighbors.nodes.some((n) => n.address === entity.address);
            const nodes = centerInNodes
                ? neighbors.nodes
                : [entity, ...neighbors.nodes];
            setGraphData({
                ...neighbors,
                nodes,
                total_nodes: nodes.length,
            });

            setPathResult(null);
            toast.dismiss(loadId);
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Failed to fetch data");
        } finally {
            setLoading(false);
        }
    };

    const handleNodeSelect = async (address: string) => {
        setSelectedEdge(null);
        try {
            const entity = await fetchEntity(address);
            setSelectedNode(entity);
        } catch {
            setSelectedNode({ address, risk_level: "unknown", labels: [], properties: {} });
        }
    };

    const handleEdgeSelect = async (txHash: string) => {
        setSelectedNode(null);
        // Try finding the tx in already-loaded graph data first
        const cached = graphData?.transactions.find((t) => t.hash === txHash) ?? null;
        if (cached) {
            setSelectedEdge(cached);
            return;
        }
        try {
            const tx = await fetchTransaction(txHash);
            setSelectedEdge(tx);
        } catch {
            // Minimal fallback so the panel still opens
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

                // Merge any path nodes/txs not yet in graph
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

    // Derived highlight sets
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

    // Filter helpers
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
        <div className="app-body" style={{ flexDirection: "column" }}>
            {/* Path finder bar — slides open above the graph */}
            <div
                className={`path-finder-bar${pathFinderOpen ? " path-finder-bar--open" : ""}${pathResult ? " path-finder-bar--active" : ""}`}
            >
                <div className="path-finder-bar__inner">
                    <input
                        className="path-finder-input"
                        placeholder="Source address (0x…)"
                        value={pathSource}
                        onChange={(e) => setPathSource(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleFindPath()}
                    />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                    </svg>
                    <input
                        className="path-finder-input"
                        placeholder="Target address (0x…)"
                        value={pathTarget}
                        onChange={(e) => setPathTarget(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleFindPath()}
                    />
                    <button
                        className="action-btn action-btn-primary"
                        style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}
                        onClick={handleFindPath}
                        disabled={pathLoading}
                    >
                        {pathLoading ? "Finding…" : "Find Path"}
                    </button>
                    {pathResult && (
                        <button
                            className="action-btn action-btn-secondary"
                            style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}
                            onClick={() => setPathResult(null)}
                        >
                            Clear
                        </button>
                    )}
                </div>
            </div>

            {/* Main body row */}
            <div className="app-body" style={{ flex: 1, minHeight: 0 }}>
                {/* Graph area */}
                <main className="graph-area grid-bg">
                    {/* Loading indicator */}
                    {loading && (
                        <div
                            style={{
                                position: "absolute",
                                top: 12,
                                left: "50%",
                                transform: "translateX(-50%)",
                                zIndex: 10,
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "5px 12px",
                                borderRadius: "var(--radius-full)",
                                background: "rgba(15,23,42,0.75)",
                                color: "rgba(255,255,255,0.85)",
                                fontSize: "0.72rem",
                                fontWeight: 500,
                                backdropFilter: "blur(6px)",
                                border: "1px solid rgba(255,255,255,0.08)",
                            }}
                        >
                            <svg className="toast-spin" width="11" height="11" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
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

                            {/* Filter toggle button */}
                            {!filterPanelOpen && (
                                <button
                                    className="graph-filter-toggle"
                                    title="Toggle filters"
                                    onClick={() => setFilterPanelOpen(true)}
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                                    </svg>
                                </button>
                            )}

                            {/* Path finder toggle button */}
                            <button
                                className="path-finder-toggle"
                                title="Path finder"
                                onClick={() => setPathFinderOpen((o) => !o)}
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                                </svg>
                            </button>

                            {/* Filter panel */}
                            {filterPanelOpen && (
                                <div className="graph-filter-panel">
                                    <div className="graph-filter-panel__header">
                                        <span style={{ fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>
                                            Filters
                                        </span>
                                        <button
                                            className="btn-icon"
                                            style={{ width: 22, height: 22 }}
                                            onClick={() => setFilterPanelOpen(false)}
                                        >
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <line x1="18" y1="6" x2="6" y2="18" />
                                                <line x1="6" y1="6" x2="18" y2="18" />
                                            </svg>
                                        </button>
                                    </div>

                                    <div className="graph-filter-panel__section">
                                        <span className="panel-section-label" style={{ marginBottom: 4 }}>Entity Type</span>
                                        {ALL_ENTITY_TYPES.map((type) => (
                                            <label key={type} className="filter-checkbox-row">
                                                <input
                                                    type="checkbox"
                                                    checked={filters.entityTypes.has(type)}
                                                    onChange={() => toggleEntityType(type)}
                                                    style={{ marginRight: 6 }}
                                                />
                                                {type}
                                            </label>
                                        ))}
                                    </div>

                                    <div className="graph-filter-panel__section">
                                        <span className="panel-section-label" style={{ marginBottom: 4 }}>Risk Level</span>
                                        {ALL_RISK_LEVELS.map((level) => (
                                            <label key={level} className="filter-checkbox-row">
                                                <input
                                                    type="checkbox"
                                                    checked={filters.riskLevels.has(level)}
                                                    onChange={() => toggleRiskLevel(level)}
                                                    style={{ marginRight: 6 }}
                                                />
                                                <span
                                                    className="filter-risk-dot"
                                                    style={{ background: RISK_DOT_COLORS[level] }}
                                                />
                                                {level}
                                            </label>
                                        ))}
                                    </div>

                                    <div className="graph-filter-panel__section">
                                        <span className="panel-section-label" style={{ marginBottom: 4 }}>Address Search</span>
                                        <input
                                            type="text"
                                            className="path-finder-input"
                                            style={{ width: "100%", boxSizing: "border-box" }}
                                            placeholder="0x… or name"
                                            value={filters.addressSearch}
                                            onChange={(e) => setFilters((prev) => ({ ...prev, addressSearch: e.target.value }))}
                                        />
                                    </div>

                                    <div style={{ padding: "0 10px 10px" }}>
                                        <button
                                            className="action-btn action-btn-secondary"
                                            style={{ fontSize: "0.72rem", padding: "5px 10px" }}
                                            onClick={() => setFilters(DEFAULT_FILTERS)}
                                        >
                                            Reset filters
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="graph-stats-bar">
                                <span className="stats-chip">
                                    <span className="stats-chip-dot" style={{ background: "var(--accent-blue)" }} />
                                    {graphData.total_nodes} entities
                                </span>
                                <span className="stats-chip">
                                    <span className="stats-chip-dot" style={{ background: "var(--accent-green)" }} />
                                    {graphData.total_transactions} transactions
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="graph-empty">
                            <div className="graph-empty-icon">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
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
                            <div style={{ textAlign: "center" }}>
                                <p className="graph-empty-title">Transaction Graph Explorer.</p>
                                <p className="graph-empty-hint" style={{ marginTop: 8 }}>
                                    Enter an Ethereum address to map its on-chain relationships
                                    <br />
                                    and trace fund flows across the network.
                                </p>
                            </div>
                            <button
                                className="graph-example-chip"
                                onClick={() => handleSearch("0x28c6c06298d514db089934071355e5743bf21d60")}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                                Try Binance: 0x28c6…1d60
                            </button>
                        </div>
                    )}
                </main>

                {(selectedNode || selectedEdge) && (
                    <aside className="side-panel">
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
                            <EdgePanel
                                tx={selectedEdge}
                                onClose={() => setSelectedEdge(null)}
                                onNavigateToAddress={handleNodeSelect}
                            />
                        )}
                    </aside>
                )}
            </div>
        </div>
    );
}
