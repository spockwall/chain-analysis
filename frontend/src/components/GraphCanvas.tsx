/**
 * Graph visualization component using Cytoscape.js — Oravia light-mode style.
 * Transactions are collapsed into direct Entity→Entity edges (tx-as-visual-edge).
 */
import { useEffect, useRef, useCallback } from "react";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import dagre from "cytoscape-dagre";
import type { NeighborsResponse, TransactionResponse } from "../types";
import { formatWei } from "../api/client";
import { ENTITY_COLORS, RISK_COLOR } from "../constants";
import { GRAPH_STYLESHEET } from "./graph/stylesheet";
import { runLayout, LAYOUT_FCOSE_INITIAL } from "./graph/layouts";

export type { LayoutName } from "./graph/layouts";

cytoscape.use(fcose);
cytoscape.use(dagre);

export interface GraphFilters {
    entityTypes: Set<string>;
    riskLevels: Set<string>;
    addressSearch: string;
}

interface GraphCanvasProps {
    data: NeighborsResponse;
    onNodeSelect: (address: string) => void;
    onNodeExpand: (address: string) => void;
    onEdgeSelect?: (txHash: string) => void;
    selectedAddress?: string;
    selectedEdgeTxHash?: string | null;
    activeLayout: import("./graph/layouts").LayoutName;
    onLayoutChange: (layout: import("./graph/layouts").LayoutName) => void;
    filters: GraphFilters;
    highlightedNodeIds?: Set<string>;
    highlightedEdgeIds?: Set<string>;
}

const ctrlBtn = "w-[30px] h-[30px] flex items-center justify-center border-none bg-transparent rounded cursor-pointer text-gray-500 transition-colors p-0 hover:bg-gray-100 hover:text-gray-900";
const ctrlBtnActive = ctrlBtn + " !bg-gray-900 !text-white hover:!bg-[#1e293b] hover:!text-white";

export function GraphCanvas({
    data,
    onNodeSelect,
    onNodeExpand,
    onEdgeSelect,
    selectedAddress,
    selectedEdgeTxHash,
    activeLayout,
    onLayoutChange,
    filters,
    highlightedNodeIds,
    highlightedEdgeIds,
}: GraphCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<Core | null>(null);

    const toElements = useCallback((): ElementDefinition[] => {
        const els: ElementDefinition[] = [];

        const knownNodeIds = new Set(data.nodes.map((n) => n.address));

        for (const node of data.nodes) {
            const entityType = node.entity_type || "Unknown";
            const label = node.name ? node.name : `${node.address.slice(0, 6)}…${node.address.slice(-4)}`;
            const memberCount = node.member_count ?? 0;
            els.push({
                data: {
                    id: node.address,
                    label,
                    entityType,
                    riskLevel: node.risk_level,
                    bgColor: ENTITY_COLORS[entityType],
                    borderColor: RISK_COLOR[node.risk_level],
                    nodeKind: memberCount > 0 ? "group" : "entity",
                    memberCount,
                },
            });
        }

        const grouped = new Map<string, TransactionResponse[]>();
        for (const tx of data.transactions) {
            if (!knownNodeIds.has(tx.from_address) || !knownNodeIds.has(tx.to_address)) continue;
            const key = `${tx.from_address}::${tx.to_address}`;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(tx);
        }

        for (const [, group] of grouped) {
            const total = group.length;
            group.forEach((tx, index) => {
                const offset = (index - (total - 1) / 2) * 60;
                const controlPointDistance = offset === 0 ? "0" : String(Math.round(offset));
                els.push({
                    data: {
                        id: `tx-${tx.hash}`,
                        source: tx.from_address,
                        target: tx.to_address,
                        edgeKind: "TRANSFER",
                        txHash: tx.hash,
                        value: tx.value,
                        blockNumber: tx.block_number,
                        label: formatWei(tx.value),
                        controlPointDistance,
                        isOutgoing: tx.from_address === data.center_address,
                    },
                });
            });
        }

        return els;
    }, [data]);

    useEffect(() => {
        if (!containerRef.current) return;
        const cy = cytoscape({
            container: containerRef.current,
            elements: toElements(),
            style: GRAPH_STYLESHEET,
            layout: LAYOUT_FCOSE_INITIAL as any,
            minZoom: 0.1,
            maxZoom: 4,
        });
        cy.on("tap", "node", (evt) => onNodeSelect(evt.target.id()));
        cy.on("dbltap", "node", (evt) => onNodeExpand(evt.target.id()));
        cy.on("tap", "edge", (evt) => {
            const txHash = evt.target.data("txHash") as string | undefined;
            if (txHash) onEdgeSelect?.(txHash);
        });
        if (data.center_address) cy.getElementById(data.center_address).addClass("center");
        cyRef.current = cy;
        return () => cy.destroy();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;
        const currentIds = new Set(cy.elements().map((ele) => ele.id()));
        const newEls = toElements();
        const newIds = new Set(newEls.map((e) => e.data.id as string));
        cy.elements().forEach((ele) => { if (!newIds.has(ele.id())) ele.remove(); });
        const toAdd = newEls.filter((e) => !currentIds.has(e.data.id as string));
        if (toAdd.length > 0) { cy.add(toAdd); runLayout(cy, activeLayout); }
        cy.nodes().removeClass("center");
        if (data.center_address) cy.getElementById(data.center_address).addClass("center");
    }, [data, toElements]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.nodes().removeClass("highlighted");
        if (selectedAddress) cy.getElementById(selectedAddress).addClass("highlighted");
    }, [selectedAddress]);

    useEffect(() => {
        if (cyRef.current) runLayout(cyRef.current, activeLayout);
    }, [activeLayout]);

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;
        (cy.elements() as any).show();
        cy.nodes('[nodeKind="entity"]').forEach((n) => {
            if (!filters.entityTypes.has(n.data("entityType")) || !filters.riskLevels.has(n.data("riskLevel"))) {
                (n as any).hide();
            }
        });
        cy.edges().forEach((e) => {
            if ((cy.getElementById(e.data("source")) as any).hidden() || (cy.getElementById(e.data("target")) as any).hidden()) {
                (e as any).hide();
            }
        });
        cy.nodes().removeClass("search-match");
        if (filters.addressSearch.trim().length >= 4) {
            const q = filters.addressSearch.toLowerCase();
            cy.nodes().forEach((n) => {
                if (n.id().toLowerCase().includes(q) || (n.data("label") as string).toLowerCase().includes(q)) {
                    n.addClass("search-match");
                }
            });
        }
    }, [filters]);

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.elements().removeClass("on-path");
        highlightedNodeIds?.forEach((id) => cy.getElementById(id).addClass("on-path"));
        highlightedEdgeIds?.forEach((id) => cy.getElementById(id).addClass("on-path"));
    }, [highlightedNodeIds, highlightedEdgeIds]);

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.edges().removeClass("edge-selected");
        if (selectedEdgeTxHash) cy.getElementById(`tx-${selectedEdgeTxHash}`).addClass("edge-selected");
    }, [selectedEdgeTxHash]);

    return (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
            {/* Controls overlay */}
            <div className="absolute bottom-5 right-5 flex flex-col gap-1 z-10 bg-[rgba(249,250,251,0.92)] border border-gray-200 rounded-lg p-1.5 shadow-md backdrop-blur-sm">
                <button
                    className={ctrlBtn}
                    title="Zoom in"
                    onClick={() => {
                        const cy = cyRef.current;
                        if (!cy) return;
                        cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                    </svg>
                </button>
                <button
                    className={ctrlBtn}
                    title="Zoom out"
                    onClick={() => {
                        const cy = cyRef.current;
                        if (!cy) return;
                        cy.zoom({ level: cy.zoom() * 0.77, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        <line x1="8" y1="11" x2="14" y2="11" />
                    </svg>
                </button>
                <button className={ctrlBtn} title="Fit to view" onClick={() => cyRef.current?.fit(undefined, 40)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
                    </svg>
                </button>
                <div className="h-px bg-gray-100 my-0.5" />
                <button
                    className={ctrlBtn}
                    title="Re-run layout"
                    onClick={() => { if (cyRef.current) runLayout(cyRef.current, activeLayout); }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                    </svg>
                </button>
                <button
                    className={activeLayout === "dagre" ? ctrlBtnActive : ctrlBtn}
                    title="Toggle layout (fcose ↔ dagre)"
                    onClick={() => onLayoutChange(activeLayout === "fcose" ? "dagre" : "fcose")}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="7" width="5" height="5" rx="1" /><rect x="17" y="3" width="5" height="5" rx="1" />
                        <rect x="17" y="16" width="5" height="5" rx="1" />
                        <line x1="7" y1="9.5" x2="17" y2="5.5" /><line x1="7" y1="9.5" x2="17" y2="18.5" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
