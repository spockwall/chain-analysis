/**
 * Graph Explorer page — main address search & graph view.
 * Extracted from App.tsx so App.tsx stays a thin router shell.
 */
import { useState, useEffect } from "react";
import { GraphCanvas } from "../components/GraphCanvas";
import { NodePanel } from "../components/NodePanel";
import type { EntityResponse, NeighborsResponse } from "../types";
import { fetchEntity, fetchNeighbors } from "../api/client";

interface GraphExplorerPageProps {
    /** Address passed from the nav search bar */
    initialAddress?: string | null;
    /** Called once the address has been consumed */
    onAddressLoad?: () => void;
}

export function GraphExplorerPage({ initialAddress, onAddressLoad }: GraphExplorerPageProps) {
    const [graphData, setGraphData] = useState<NeighborsResponse | null>(null);
    const [selectedNode, setSelectedNode] = useState<EntityResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Consume address passed from the nav search bar
    useEffect(() => {
        if (initialAddress) {
            handleSearch(initialAddress);
            onAddressLoad?.();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialAddress]);

    const handleSearch = async (address: string) => {
        setLoading(true);
        setError(null);
        try {
            const [entity, neighbors] = await Promise.all([
                fetchEntity(address),
                fetchNeighbors(address, { depth: 1, limit: 50 }),
            ]);
            setSelectedNode(entity);
            setGraphData(neighbors);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to fetch data");
        } finally {
            setLoading(false);
        }
    };

    const handleNodeSelect = async (address: string) => {
        setLoading(true);
        setError(null);
        try {
            const entity = await fetchEntity(address);
            setSelectedNode(entity);
        } catch {
            setSelectedNode({ address, risk_level: "unknown", labels: [], properties: {} });
        } finally {
            setLoading(false);
        }
    };

    const handleExpandNode = async (address: string) => {
        setLoading(true);
        setError(null);
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
            } else {
                setGraphData(neighbors);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to expand node");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="app-body">
            {/* Graph area */}
            <main className="graph-area grid-bg">
                {/* Loading toast */}
                {loading && (
                    <div className="toast toast-loading">
                        <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <circle
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeDasharray="40 20"
                            />
                        </svg>
                        Fetching graph data…
                    </div>
                )}

                {/* Error toast */}
                {error && !loading && (
                    <div className="toast toast-error">
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        {error}
                    </div>
                )}

                {graphData ? (
                    <>
                        <GraphCanvas
                            data={graphData}
                            onNodeSelect={handleNodeSelect}
                            onNodeExpand={handleExpandNode}
                            selectedAddress={selectedNode?.address}
                        />
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
            </main>

            {/* Side panel */}
            {selectedNode && (
                <aside className="side-panel">
                    <NodePanel
                        node={selectedNode}
                        onExpand={() => handleExpandNode(selectedNode.address)}
                        onClose={() => setSelectedNode(null)}
                    />
                </aside>
            )}
        </div>
    );
}
