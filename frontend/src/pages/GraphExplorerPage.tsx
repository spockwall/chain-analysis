/**
 * Graph Explorer page — main address search & graph view.
 */
import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { GraphCanvas, type LayoutName, type GraphFilters } from "../components/GraphCanvas";
import { NodePanel } from "../components/NodePanel";
import { TxPanel } from "../components/TxPanel";
import { useToastContext } from "../context/ToastContext";
import { useIngestionRuns } from "../context/IngestionRunsContext";
import type {
    DetectionPattern,
    DetectionsResponse,
    EntityResponse,
    FavoritePathResponse,
    NeighborsResponse,
    PathResponse,
    TransactionResponse,
} from "../types";
import {
    createFavoritePath,
    deleteFavoritePath,
    fetchDetection,
    fetchEntity,
    fetchNeighbors,
    fetchPaths,
    fetchTransaction,
    ingestAddress,
    listFavoritePaths,
} from "../api/client";
import { useAuth } from "../context/AuthContext";
import { ENTITY_TYPES, RISK_LEVELS, RISK_COLOR } from "../constants";
import { Background } from "../components/Background";

interface GraphExplorerPageProps {
    initialAddress?: string | null;
    initialTxHash?: string | null;
}

const DEFAULT_FILTERS: GraphFilters = {
    entityTypes: new Set(ENTITY_TYPES),
    riskLevels: new Set(RISK_LEVELS),
    addressSearch: "",
};

// shared input style used in path-finder and filter panel
const monoInput =
    "w-60 px-2.5 py-1.5 border border-gray-200 rounded-lg text-[0.75rem] font-mono bg-white text-gray-900 outline-none transition-colors focus:border-blue-400";

const DETECTION_PATTERNS: Array<{ value: DetectionPattern; label: string }> = [
    { value: "peel-chain", label: "Peel Chain" },
    { value: "structuring", label: "Structuring" },
    { value: "round-trip", label: "Round Trip" },
    { value: "fan-out-fan-in", label: "Fan-Out / Fan-In" },
    { value: "mixer-interaction", label: "Mixer Interaction" },
];

const formatFavoritePathLabel = (favorite: FavoritePathResponse) => {
    if (favorite.label) return favorite.label;
    return `${favorite.source.slice(0, 6)}...${favorite.source.slice(-4)} -> ${favorite.target.slice(0, 6)}...${favorite.target.slice(-4)}`;
};

export function GraphExplorerPage({ initialAddress, initialTxHash }: GraphExplorerPageProps) {
    const toast = useToastContext();
    const { track: trackRun } = useIngestionRuns();
    const [, setSearchParams] = useSearchParams();
    const [graphData, setGraphData] = useState<NeighborsResponse | null>(null);
    const [selectedNode, setSelectedNode] = useState<EntityResponse | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<TransactionResponse | null>(null);
    const [loading, setLoading] = useState(false);

    // Tracing mode: recursive expansion & group red nodes
    const [tracingModeEnabled, setTracingModeEnabled] = useState(false);
    const [preTracingSnapshot, setPreTracingSnapshot] = useState<NeighborsResponse | null>(null);

    const [activeLayout, setActiveLayout] = useState<LayoutName>("fcose");
    const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
    const [filterPanelOpen, setFilterPanelOpen] = useState(false);

    const [pathFinderOpen, setPathFinderOpen] = useState(false);
    const [pathSource, setPathSource] = useState("");
    const [pathTarget, setPathTarget] = useState("");
    const [pathResult, setPathResult] = useState<PathResponse | null>(null);
    const [pathLoading, setPathLoading] = useState(false);
    const { isAuthenticated } = useAuth();
    const [favoritePaths, setFavoritePaths] = useState<FavoritePathResponse[]>([]);
    const [selectedFavoritePathId, setSelectedFavoritePathId] = useState("");
    const [detectionPattern, setDetectionPattern] = useState<DetectionPattern>("peel-chain");
    const [detectionAddress, setDetectionAddress] = useState("");
    const [detectionLoading, setDetectionLoading] = useState(false);
    const [detectionResult, setDetectionResult] = useState<DetectionsResponse | null>(null);

    useEffect(() => {
        if (initialAddress) handleSearch(initialAddress);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialAddress]);

    useEffect(() => {
        if (initialTxHash) handleTxSearch(initialTxHash);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialTxHash]);

    useEffect(() => {
        if (graphData?.center_address && !detectionAddress) {
            setDetectionAddress(graphData.center_address);
        }
    }, [graphData?.center_address, detectionAddress]);

    useEffect(() => {
        if (!isAuthenticated) {
            setFavoritePaths([]);
            setSelectedFavoritePathId("");
            return;
        }
        let cancelled = false;
        listFavoritePaths()
            .then((items) => {
                if (!cancelled) setFavoritePaths(items);
            })
            .catch((err) => {
                if (!cancelled) toast.error(err instanceof Error ? err.message : "Failed to load favorites");
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated]);

    const handleSearch = async (address: string, opts?: { waitForGraph?: boolean }) => {
        // Keep URL in sync so a refresh restores this view.
        setSearchParams({ address }, { replace: true });
        setLoading(true);
        const loadId = toast.loading("Fetching graph data…");
        try {
            // When called right after an ingest completes, the Rust worker has
            // XADDed txs to Redis but task C (stream→Neo4j) may still be
            // draining. Retry briefly so the first render isn't empty.
            const maxAttempts = opts?.waitForGraph ? 8 : 1;
            let entity: EntityResponse | null = null;
            let neighbors: Awaited<ReturnType<typeof fetchNeighbors>> | null = null;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const [entityResult, neighborsResult] = await Promise.allSettled([
                    fetchEntity(address),
                    fetchNeighbors(address, { depth: 1, limit: 500 }),
                ]);

                entity =
                    entityResult.status === "fulfilled"
                        ? entityResult.value
                        : { address, risk_level: "unknown", labels: [], properties: {} };

                if (neighborsResult.status === "rejected") throw neighborsResult.reason;
                neighbors = neighborsResult.value;

                if (!opts?.waitForGraph || neighbors.nodes.length > 0) break;
                // Neo4j consumer still draining — back off and retry (0.5s, 1s, ..., up to ~8s total).
                await new Promise((r) => setTimeout(r, 1000));
            }

            if (!entity || !neighbors) throw new Error("no graph data");
            setSelectedNode(entity);
            const centerInNodes = neighbors.nodes.some((n) => n.address === entity!.address);
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
        setSearchParams({ tx: hash }, { replace: true });
        setLoading(true);
        const loadId = toast.loading("Fetching transaction…");
        try {
            let tx: TransactionResponse | null = null;
            try {
                tx = await fetchTransaction(hash);
            } catch (err: any) {
                if (err?.status === 404) {
                    const addrToIngest = selectedNode?.address;
                    if (!addrToIngest) {
                        toast.dismiss(loadId);
                        toast.error("Transaction not found. Search for a related address first to load its transactions.");
                        setLoading(false);
                        return;
                    }
                    toast.dismiss(loadId);
                    toast.info(
                        `Transaction not found. Queued ingest of ${addrToIngest.slice(0, 10)}… — retry when the run pill shows completed.`,
                    );
                    try {
                        const queued = await ingestAddress({ address: addrToIngest });
                        trackRun(queued.run_id, {
                            onComplete: (run) => {
                                if (run.status === "completed") {
                                    toast.success("Ingest complete — try the transaction again.");
                                } else {
                                    toast.error(`Ingest failed${run.error_message ? `: ${run.error_message}` : ""}`);
                                }
                            },
                        });
                    } catch (ingestErr: any) {
                        toast.error(ingestErr?.message || "Failed to queue ingest");
                    }
                    setLoading(false);
                    return;
                } else {
                    throw err;
                }
            }
            if (!tx) throw new Error("Transaction not found after ingestion");

            // Load neighbors for both endpoints in parallel, tolerating 404s
            const [fromNeighbors, toNeighbors] = await Promise.allSettled([
                fetchNeighbors(tx.from_address, { depth: 1, limit: 50 }),
                fetchNeighbors(tx.to_address, { depth: 1, limit: 50 }),
            ]);

            // Merge nodes and transactions from both sides, deduplicating by address/hash
            const seenAddresses = new Set<string>();
            const seenHashes = new Set<string>();
            const mergedNodes: NeighborsResponse["nodes"] = [];
            const mergedTxs: NeighborsResponse["transactions"] = [];

            for (const result of [fromNeighbors, toNeighbors]) {
                if (result.status === "rejected") continue;
                for (const n of result.value.nodes) {
                    if (!seenAddresses.has(n.address)) {
                        seenAddresses.add(n.address);
                        mergedNodes.push(n);
                    }
                }
                for (const t of result.value.transactions) {
                    if (!seenHashes.has(t.hash)) {
                        seenHashes.add(t.hash);
                        mergedTxs.push(t);
                    }
                }
            }

            // Ensure both endpoint stubs are present even if they have no Entity node
            for (const addr of [tx.from_address, tx.to_address]) {
                if (!seenAddresses.has(addr)) {
                    seenAddresses.add(addr);
                    mergedNodes.push({ address: addr, risk_level: "unknown", labels: [], properties: {} });
                }
            }

            // Ensure the looked-up tx itself is in the list
            if (!seenHashes.has(tx.hash)) mergedTxs.push(tx);

            setSelectedNode(null);
            setSelectedEdge(tx);
            setGraphData({
                center_address: tx.from_address,
                nodes: mergedNodes,
                transactions: mergedTxs,
                total_nodes: mergedNodes.length,
                total_transactions: mergedTxs.length,
            });
            setPathResult(null);
            toast.dismiss(loadId);
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Transaction not found");
        } finally {
            setLoading(false);
        }
    };

    const handleNodeSelect = async (address: string) => {
        setSelectedEdge(null);

        // Handle clicking the synthetic group node by building a fake EntityResponse 
        // with all the grouped red node addresses as members
        if (tracingModeEnabled && address === "synthetic_high_risk_group" && graphData) {
            const memberCount = graphData.nodes.filter((n) => n.risk_level === "critical").length;

            setSelectedNode({
                address: "synthetic_high_risk_group",
                entity_type: "Mixer", // Give it it a standard group type to map properties cleanly
                name: "High-Risk Network",
                risk_level: "critical",
                labels: ["Trace Group"],
                properties: {
                    Description: "Auto-grouped critical risk entities identified during trace completion.",
                    "Entities Grouped": String(memberCount)
                },
                member_count: memberCount,
            });
            return;
        }

        try {
            setSelectedNode(await fetchEntity(address));
        } catch {
            setSelectedNode({ address, risk_level: "unknown", labels: [], properties: {} });
        }
    };

    const handleEdgeSelect = async (txHash: string) => {
        const currentAddress = selectedNode?.address;
        setSelectedNode(null);
        const cached = graphData?.transactions.find((t) => t.hash === txHash) ?? null;
        if (cached) {
            setSelectedEdge(cached);
            return;
        }
        try {
            setSelectedEdge(await fetchTransaction(txHash));
        } catch (err: any) {
            if (err?.status === 404 && currentAddress) {
                // Queue an async ingest; show a placeholder edge now and
                // retry the fetch when the run completes.
                setSelectedEdge({ hash: txHash, from_address: "", to_address: "", properties: {} });
                try {
                    const queued = await ingestAddress({ address: currentAddress });
                    trackRun(queued.run_id, {
                        onComplete: async (run) => {
                            if (run.status !== "completed") return;
                            try {
                                setSelectedEdge(await fetchTransaction(txHash));
                            } catch {
                                // still missing — leave placeholder
                            }
                        },
                    });
                } catch {
                    // ignore; placeholder already shown
                }
            } else {
                setSelectedEdge({ hash: txHash, from_address: "", to_address: "", properties: {} });
            }
        }
    };

    const handleExpandNode = async (address: string) => {
        setLoading(true);
        const loadId = toast.loading("Expanding node…");
        try {
            const neighbors = await fetchNeighbors(address, { depth: 1, limit: 500 });
            if (graphData) {
                const existingAddresses = new Set(graphData.nodes.map((n) => n.address));
                const newNodes = neighbors.nodes.filter((n) => !existingAddresses.has(n.address));
                const existingTxHashes = new Set(graphData.transactions.map((t) => t.hash));
                const newTxs = neighbors.transactions.filter((t) => !existingTxHashes.has(t.hash));

                // If tracing mode is on, we want the new nodes to appear and automatically group if they are red.
                // We add them to graphData, but we DO NOT update preTracingSnapshot so reversion still works.
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

    const handleIngestAndLoad = async (address: string) => {
        setLoading(true);
        try {
            const result = await ingestAddress({ address });
            toast.success("Queued ingest — graph will refresh when run completes.");
            trackRun(result.run_id, {
                onComplete: async (run) => {
                    if (run.status !== "completed") {
                        toast.error(`Ingest failed${run.error_message ? `: ${run.error_message}` : ""}`);
                        return;
                    }
                    toast.success(`Ingest complete — ${run.transactions_processed} txs`);
                    await handleSearch(address, { waitForGraph: true });
                },
            });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to queue ingest");
        } finally {
            setLoading(false);
        }
    };

    const handleToggleTracingMode = async () => {
        if (tracingModeEnabled) {
            // Revert to snapshot
            if (preTracingSnapshot) {
                setGraphData(preTracingSnapshot);
            }
            setTracingModeEnabled(false);
            setPreTracingSnapshot(null);
            return;
        }

        if (!graphData || graphData.nodes.length === 0) return;

        setLoading(true);
        const loadId = toast.loading("Tracing high-risk network…");
        try {
            // Save snapshot before expanding
            setPreTracingSnapshot(graphData);

            let currentNodes = [...graphData.nodes];
            let currentTxs = [...graphData.transactions];
            const seenAddresses = new Set(currentNodes.map((n) => n.address));
            const seenTxHashes = new Set(currentTxs.map((t) => t.hash));
            const nodesAlreadyExpanded = new Set<string>();

            // Recursively fetch 2 hops out from CURRENT visible nodes
            const maxDepth = 2;
            for (let depth = 0; depth < maxDepth; depth++) {
                // Determine nodes we haven't expanded from yet in this pass
                const addressesToExpand = currentNodes
                    .map((n) => n.address)
                    .filter((addr) => !nodesAlreadyExpanded.has(addr));

                if (addressesToExpand.length === 0) break;

                // We fetch in chunks to avoid slamming the backend
                const batchSize = 10;
                const newNodes: EntityResponse[] = [];
                const newTxs: TransactionResponse[] = [];

                for (let i = 0; i < addressesToExpand.length; i += batchSize) {
                    const batch = addressesToExpand.slice(i, i + batchSize);

                    // Mark as expanded before fetching to ensure we don't request again
                    batch.forEach(addr => nodesAlreadyExpanded.add(addr));

                    const results = await Promise.allSettled(
                        batch.map((addr) => fetchNeighbors(addr, { depth: 1, limit: 50 }))
                    );

                    for (const res of results) {
                        if (res.status === "fulfilled") {
                            res.value.nodes.forEach((n) => {
                                if (!seenAddresses.has(n.address)) {
                                    seenAddresses.add(n.address);
                                    newNodes.push(n);
                                }
                            });
                            res.value.transactions.forEach((tx) => {
                                if (!seenTxHashes.has(tx.hash)) {
                                    seenTxHashes.add(tx.hash);
                                    newTxs.push(tx);
                                }
                            });
                        }
                    }
                }

                currentNodes = [...currentNodes, ...newNodes];
                currentTxs = [...currentTxs, ...newTxs];

                // If no new nodes discovered, stop recursion early
                if (newNodes.length === 0) break;
            }

            setGraphData({
                ...graphData,
                nodes: currentNodes,
                transactions: currentTxs,
                total_nodes: currentNodes.length,
                total_transactions: currentTxs.length,
            });

            setTracingModeEnabled(true);
            toast.dismiss(loadId);
            toast.success("High-risk trace complete");

            // Force DAGre layout for better flow visualization when tracing
            setActiveLayout("dagre");
        } catch (err) {
            toast.dismiss(loadId);
            toast.error("Failed to trace network");
            setPreTracingSnapshot(null);
        } finally {
            setLoading(false);
        }
    };

    const normalizePathAddress = (address: string) => address.trim().toLowerCase();

    const currentFavoritePath = useMemo(() => {
        const source = normalizePathAddress(pathSource);
        const target = normalizePathAddress(pathTarget);
        if (!source || !target) return null;
        return favoritePaths.find((favorite) => favorite.source === source && favorite.target === target) ?? null;
    }, [favoritePaths, pathSource, pathTarget]);

    const handleSaveFavoritePath = async () => {
        if (!isAuthenticated) {
            toast.error("Sign in to save favorite paths");
            return;
        }

        const source = normalizePathAddress(pathSource);
        const target = normalizePathAddress(pathTarget);

        if (!source || !target) {
            toast.error("Enter both source and target addresses before saving");
            return;
        }

        if (source === target) {
            toast.error("Source and target must be different");
            return;
        }

        if (currentFavoritePath) {
            toast.info("Path is already in favorites");
            return;
        }

        try {
            const favorite = await createFavoritePath({ source, target });
            setFavoritePaths((prev) => [favorite, ...prev]);
            setSelectedFavoritePathId(String(favorite.id));
            toast.success("Favorite path saved");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save favorite");
        }
    };

    const handleSelectFavoritePath = (favoriteId: string) => {
        setSelectedFavoritePathId(favoriteId);
        const favorite = favoritePaths.find((item) => String(item.id) === favoriteId);
        if (!favorite) return;

        setPathSource(favorite.source);
        setPathTarget(favorite.target);
        setPathResult(null);
    };

    const handleRemoveSelectedFavoritePath = async () => {
        const favorite =
            favoritePaths.find((item) => String(item.id) === selectedFavoritePathId) ?? currentFavoritePath;
        if (!favorite) {
            toast.error("Select a favorite path to remove");
            return;
        }

        try {
            await deleteFavoritePath(favorite.id);
            setFavoritePaths((prev) => prev.filter((item) => item.id !== favorite.id));
            setSelectedFavoritePathId("");
            toast.info("Favorite path removed");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to remove favorite");
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

    const handleRunDetection = async () => {
        const address = detectionAddress.trim() || graphData?.center_address || "";
        if (!address) {
            toast.error("Enter an address for detection");
            return;
        }

        setDetectionLoading(true);
        const loadId = toast.loading("Running AML detection…");
        try {
            const result = await fetchDetection(detectionPattern, address, { limit: 20 });
            setDetectionResult(result);

            if (graphData) {
                const existingAddresses = new Set(graphData.nodes.map((n) => n.address));
                const existingTxHashes = new Set(graphData.transactions.map((t) => t.hash));
                const addNodes = result.nodes.filter((n) => !existingAddresses.has(n.address));
                const addTxs = result.transactions.filter((t) => !existingTxHashes.has(t.hash));

                if (addNodes.length > 0 || addTxs.length > 0) {
                    setGraphData({
                        ...graphData,
                        nodes: [...graphData.nodes, ...addNodes],
                        transactions: [...graphData.transactions, ...addTxs],
                        total_nodes: graphData.nodes.length + addNodes.length,
                        total_transactions: graphData.transactions.length + addTxs.length,
                    });
                }
            }

            toast.dismiss(loadId);
            toast.success(`Detection finished: ${result.matches} match(es)`);
        } catch (err) {
            toast.dismiss(loadId);
            toast.error(err instanceof Error ? err.message : "Detection failed");
        } finally {
            setDetectionLoading(false);
        }
    };

    const clearDetection = () => setDetectionResult(null);

    const highlightedNodeIds = useMemo(() => {
        const ids = new Set<string>();
        if (pathResult) {
            pathResult.paths.forEach((p) => p.nodes.forEach((n) => ids.add(n.address)));
        }
        detectionResult?.highlighted_node_ids.forEach((id) => ids.add(id));
        return ids;
    }, [pathResult, detectionResult]);

    const highlightedEdgeIds = useMemo(() => {
        const ids = new Set<string>();
        if (pathResult) {
            pathResult.paths.forEach((p) => p.transactions.forEach((tx) => ids.add(`tx-${tx.hash}`)));
        }
        detectionResult?.highlighted_edge_ids.forEach((id) => ids.add(id));
        return ids;
    }, [pathResult, detectionResult]);

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
                    <button
                        className={`w-[31px] h-[31px] inline-flex items-center justify-center rounded-lg border text-[0.75rem] transition-colors disabled:opacity-45 ${
                            currentFavoritePath
                                ? "bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100"
                                : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                        }`}
                        title={currentFavoritePath ? "Favorite path saved" : "Save favorite path"}
                        onClick={handleSaveFavoritePath}
                        disabled={pathLoading}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={currentFavoritePath ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                    </button>
                    {favoritePaths.length > 0 && (
                        <>
                            <select
                                className="w-52 px-2.5 py-1.5 border border-gray-200 rounded-lg text-[0.75rem] bg-white text-gray-700 outline-none transition-colors focus:border-blue-400"
                                value={selectedFavoritePathId}
                                onChange={(e) => handleSelectFavoritePath(e.target.value)}
                                title="Favorite paths"
                            >
                                <option value="">Favorite paths</option>
                                {favoritePaths.map((favorite) => (
                                    <option key={favorite.id} value={String(favorite.id)}>
                                        {formatFavoritePathLabel(favorite)}
                                    </option>
                                ))}
                            </select>
                            <button
                                className="w-[31px] h-[31px] inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-red-600 disabled:opacity-45"
                                title="Remove selected favorite path"
                                onClick={handleRemoveSelectedFavoritePath}
                                disabled={!selectedFavoritePathId && !currentFavoritePath}
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6l-1 14H6L5 6" />
                                    <path d="M10 11v6" />
                                    <path d="M14 11v6" />
                                    <path d="M9 6V4h6v2" />
                                </svg>
                            </button>
                        </>
                    )}
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

            {/* Detections bar */}
            <div className="shrink-0 border-b border-gray-100 bg-white/80">
                <div className="flex items-center gap-2.5 px-5 py-2.5">
                    <span className="text-[0.68rem] font-semibold tracking-widest uppercase text-gray-400">
                        Detections
                    </span>
                    <select
                        className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-[0.75rem] bg-white text-gray-900"
                        value={detectionPattern}
                        onChange={(e) => setDetectionPattern(e.target.value as DetectionPattern)}
                    >
                        {DETECTION_PATTERNS.map((p) => (
                            <option key={p.value} value={p.value}>
                                {p.label}
                            </option>
                        ))}
                    </select>
                    <input
                        className="w-72 px-2.5 py-1.5 border border-gray-200 rounded-lg text-[0.75rem] font-mono bg-white text-gray-900 outline-none transition-colors focus:border-blue-400"
                        placeholder="Address (0x...)"
                        value={detectionAddress}
                        onChange={(e) => setDetectionAddress(e.target.value)}
                    />
                    <button
                        className="px-3.5 py-1.5 bg-gray-900 text-white text-[0.75rem] font-semibold rounded-lg border-none cursor-pointer transition-colors hover:bg-[#1e293b] disabled:opacity-45"
                        onClick={handleRunDetection}
                        disabled={detectionLoading}
                    >
                        {detectionLoading ? "Running..." : "Run"}
                    </button>
                    {detectionResult && (
                        <button
                            className="px-3 py-1.5 bg-white text-gray-900 text-[0.75rem] font-medium rounded-lg border border-gray-200 cursor-pointer transition-colors hover:bg-gray-50"
                            onClick={clearDetection}
                        >
                            Clear
                        </button>
                    )}
                    {detectionResult && (
                        <span className="text-[0.72rem] text-gray-500">
                            {detectionResult.matches} matches, {detectionResult.highlighted_node_ids.length} nodes, {detectionResult.highlighted_edge_ids.length} txs
                            {detectionResult.truncated ? " (truncated)" : ""}
                        </span>
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
                                tracingModeEnabled={tracingModeEnabled}
                                onToggleTracingMode={handleToggleTracingMode}
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
                                    {graphData.total_transactions.toLocaleString()} transactions
                                    {selectedNode?.transaction_count != null &&
                                        selectedNode.address === graphData.center_address &&
                                        selectedNode.transaction_count > graphData.total_transactions && (
                                            <span className="text-gray-400 font-normal">
                                                &nbsp;of {selectedNode.transaction_count.toLocaleString()}
                                            </span>
                                        )}
                                </span>
                                {graphData.total_transactions === 0 && graphData.center_address && (
                                    <button
                                        className="inline-flex items-center gap-[5px] px-3 py-[5px] bg-blue-600 text-white backdrop-blur-sm rounded-full text-[0.7rem] font-semibold border-none cursor-pointer transition-colors hover:bg-blue-700 disabled:opacity-45"
                                        onClick={() => handleIngestAndLoad(graphData.center_address)}
                                        disabled={loading}
                                    >
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                            <polyline points="7 10 12 15 17 10" />
                                            <line x1="12" y1="15" x2="12" y2="3" />
                                        </svg>
                                        Fetch from Etherscan
                                    </button>
                                )}
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
                                onClick={() => setSearchParams({ address: "0x28c6c06298d514db089934071355e5743bf21d60" })}
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
                                onIngestComplete={(addr) => handleSearch(addr, { waitForGraph: true })}
                                overrideMembers={
                                    selectedNode.address === "synthetic_high_risk_group" && graphData
                                        ? graphData.nodes.filter(n => n.risk_level === "critical")
                                        : undefined
                                }
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
