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
    tracingModeEnabled?: boolean;
    onToggleTracingMode?: () => void;
    // Per-user nicknames, keyed by lowercase address. Falls back to entity.name
    // -> truncated address when an entry is absent.
    nicknames?: Map<string, string>;
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
    tracingModeEnabled,
    onToggleTracingMode,
    nicknames,
}: GraphCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<Core | null>(null);
    const onNodeSelectRef = useRef(onNodeSelect);
    const onNodeExpandRef = useRef(onNodeExpand);
    const onEdgeSelectRef = useRef(onEdgeSelect);

    useEffect(() => {
        onNodeSelectRef.current = onNodeSelect;
    }, [onNodeSelect]);

    useEffect(() => {
        onNodeExpandRef.current = onNodeExpand;
    }, [onNodeExpand]);

    useEffect(() => {
        onEdgeSelectRef.current = onEdgeSelect;
    }, [onEdgeSelect]);

    const toElements = useCallback((): ElementDefinition[] => {
        const els: ElementDefinition[] = [];

        const knownNodeIds = new Set(data.nodes.map((n) => n.address));

        const SYNTHETIC_GROUP_ID = "synthetic_high_risk_group";
        const redNodeIds = new Set<string>();

        let redNodesCount = 0;
        let redNodesMemberCount = 0;

        // First pass: identify all red nodes when tracing is enabled
        if (tracingModeEnabled) {
            for (const node of data.nodes) {
                if (node.risk_level === "critical") {
                    redNodeIds.add(node.address);
                    redNodesCount++;
                    const mc = node.member_count ?? 0;
                    redNodesMemberCount += mc > 0 ? mc : 1;
                }
            }
        }

        for (const node of data.nodes) {
            // Skip rendering individual red nodes if they are being grouped
            if (tracingModeEnabled && redNodeIds.has(node.address)) {
                continue;
            }

            const entityType = node.entity_type || "Unknown";
            const nickname = nicknames?.get(node.address.toLowerCase());
            const baseName = node.name
                ? node.name
                : nickname
                    ? nickname
                    : `${node.address.slice(0, 6)}…${node.address.slice(-4)}`;
            const memberCount = node.member_count ?? 0;
            const isGroup = memberCount > 0;
            // For group nodes, append a second line so the member count is
            // visible directly on the canvas. Cytoscape text-wrap splits on \n.
            const label = isGroup
                ? `${baseName}\n● ${memberCount} member${memberCount === 1 ? "" : "s"}`
                : baseName;
            els.push({
                data: {
                    id: node.address,
                    label,
                    entityType,
                    riskLevel: node.risk_level,
                    bgColor: ENTITY_COLORS[entityType as keyof typeof ENTITY_COLORS] ?? ENTITY_COLORS["Unknown"],
                    borderColor: RISK_COLOR[node.risk_level] ?? RISK_COLOR["unknown"],
                    nodeKind: isGroup ? "group" : "entity",
                    memberCount,
                },
            });
        }

        // Add the synthetic group node if there were red nodes
        if (tracingModeEnabled && redNodesCount > 0) {
            els.push({
                data: {
                    id: SYNTHETIC_GROUP_ID,
                    label: `High-Risk Network\n● ${redNodesMemberCount} grouped entities`,
                    entityType: "Group",
                    riskLevel: "critical",
                    bgColor: RISK_COLOR["critical"], // bold red styling instead of light pink
                    borderColor: "#7f1d1d", // darker red border
                    nodeKind: "group",
                    memberCount: redNodesMemberCount,
                },
            });
        }

        const grouped = new Map<string, TransactionResponse[]>();
        for (const tx of data.transactions) {
            if (!knownNodeIds.has(tx.from_address) || !knownNodeIds.has(tx.to_address)) continue;

            // Remap edges referencing red nodes to the synthetic group node
            let fromAddr = tx.from_address;
            let toAddr = tx.to_address;

            if (tracingModeEnabled) {
                if (redNodeIds.has(fromAddr)) fromAddr = SYNTHETIC_GROUP_ID;
                if (redNodeIds.has(toAddr)) toAddr = SYNTHETIC_GROUP_ID;
                // We purposefully allow internal edges to render as self-loops on the group per user request
            }

            const key = `${fromAddr}::${toAddr}`;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(tx);
        }

        for (const [key, group] of grouped) {
            const total = group.length;
            group.forEach((tx, index) => {
                const offset = (index - (total - 1) / 2) * 60;
                const controlPointDistance = offset === 0 ? "0" : String(Math.round(offset));

                // When tracing is enabled, edges connected to the synthetic group aren't "outgoing" from the center in the same way
                const isOutgoing = tx.from_address === data.center_address;

                const [sourceId, targetId] = key.split("::");

                els.push({
                    data: {
                        id: `tx-${tx.hash}`,
                        source: sourceId,
                        target: targetId,
                        edgeKind: "TRANSFER",
                        txHash: tx.hash,
                        value: tx.value,
                        blockNumber: tx.block_number,
                        label: formatWei(tx.value),
                        controlPointDistance,
                        isOutgoing,
                    },
                });
            });
        }

        return els;
    }, [data, tracingModeEnabled, nicknames]);

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

        cy.on("tap", "node", (evt) => {
            onNodeSelectRef.current(evt.target.id());
        });

        cy.on("dbltap", "node", (evt) => {
            // Prevent attempting to double-click expand the synthetic group, as it is front-end only
            if (evt.target.id() !== "synthetic_high_risk_group") {
                onNodeExpandRef.current(evt.target.id());
            }
        });

        cy.on("tap", "edge", (evt) => {
            const txHash = evt.target.data("txHash") as string | undefined;
            if (txHash) onEdgeSelectRef.current?.(txHash);
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
        // Refresh labels on already-mounted nodes (e.g. when a nickname changed).
        for (const el of newEls) {
            const id = el.data.id as string;
            if (!currentIds.has(id)) continue;
            const ele = cy.getElementById(id);
            const newLabel = el.data.label as string | undefined;
            if (newLabel !== undefined && ele.data("label") !== newLabel) {
                ele.data("label", newLabel);
            }
        }
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
                    className={tracingModeEnabled ? ctrlBtnActive : ctrlBtn}
                    title="Trace High-Risk Network"
                    onClick={() => onToggleTracingMode && onToggleTracingMode()}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="7.5 4.21 12 6.81 16.5 4.21"></polyline>
                        <polyline points="7.5 19.79 7.5 14.6 3 12"></polyline>
                        <polyline points="21 12 16.5 14.6 16.5 19.79"></polyline>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                        <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                </button>
                <div className="h-px bg-gray-100 my-0.5" />
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
