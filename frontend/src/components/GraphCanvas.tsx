/**
 * Graph visualization component using Cytoscape.js — Oravia light-mode style.
 */
import { useEffect, useRef, useCallback } from "react";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { NeighborsResponse, EntityType, RiskLevel } from "../types";

cytoscape.use(fcose);

interface GraphCanvasProps {
    data: NeighborsResponse;
    onNodeSelect: (address: string) => void;
    onNodeExpand: (address: string) => void;
    selectedAddress?: string;
}

const ENTITY_COLORS: Record<EntityType | "Unknown", { bg: string; border: string }> = {
    EOA: { bg: "#0f172a", border: "#334155" },
    Contract: { bg: "#1e1b4b", border: "#4338ca" },
    Mixer: { bg: "#450a0a", border: "#ef4444" },
    LendingPool: { bg: "#0c4a6e", border: "#0ea5e9" },
    Bridge: { bg: "#451a03", border: "#f59e0b" },
    DEX: { bg: "#052e16", border: "#10b981" },
    CEXHotWallet: { bg: "#1e1b4b", border: "#6366f1" },
    Application: { bg: "#500724", border: "#ec4899" },
    Unknown: { bg: "#1e293b", border: "#475569" },
};

const RISK_RING: Record<RiskLevel, string> = {
    unknown: "#94a3b8",
    low: "#22c55e",
    medium: "#eab308",
    high: "#f97316",
    critical: "#ef4444",
};

export function GraphCanvas({ data, onNodeSelect, onNodeExpand, selectedAddress }: GraphCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<Core | null>(null);

    const toElements = useCallback((): ElementDefinition[] => {
        const els: ElementDefinition[] = [];
        for (const node of data.nodes) {
            const entityType = node.entity_type || "Unknown";
            const label = node.name ? node.name : `${node.address.slice(0, 6)}…${node.address.slice(-4)}`;
            const colors = ENTITY_COLORS[entityType];
            els.push({
                data: {
                    id: node.address,
                    label,
                    entityType,
                    riskLevel: node.risk_level,
                    bgColor: colors.bg,
                    borderColor: RISK_RING[node.risk_level],
                    nodeKind: "entity",
                },
            });
        }
        for (const tx of data.transactions) {
            // Transaction node — small diamond-shaped node between entities
            const shortHash = `${tx.hash.slice(0, 6)}…${tx.hash.slice(-4)}`;
            els.push({
                data: {
                    id: tx.hash,
                    label: shortHash,
                    txHash: tx.hash,
                    value: tx.value,
                    blockNumber: tx.block_number,
                    bgColor: "#1a2744",
                    borderColor: "#3b82f6",
                    nodeKind: "transaction",
                },
            });
            // SENT: from_address → tx
            els.push({
                data: {
                    id: `sent-${tx.hash}`,
                    source: tx.from_address,
                    target: tx.hash,
                    edgeKind: "SENT",
                },
            });
            // RECEIVED: tx → to_address
            els.push({
                data: {
                    id: `recv-${tx.hash}`,
                    source: tx.hash,
                    target: tx.to_address,
                    edgeKind: "RECEIVED",
                    value: tx.value,
                },
            });
        }
        return els;
    }, [data]);

    useEffect(() => {
        if (!containerRef.current) return;

        const cy = cytoscape({
            container: containerRef.current,
            elements: toElements(),
            style: [
                {
                    selector: "node",
                    style: {
                        "background-color": "data(bgColor)",
                        "border-width": 2.5,
                        "border-color": "data(borderColor)",
                        label: "data(label)",
                        color: "#64748b",
                        "text-valign": "bottom",
                        "text-margin-y": 10,
                        "font-size": 10,
                        "font-family": "Inter, -apple-system, sans-serif",
                        "font-weight": 500,
                        width: 36,
                        height: 36,
                    },
                },
                {
                    // Transaction nodes: smaller diamond shape
                    selector: 'node[nodeKind = "transaction"]',
                    style: {
                        shape: "diamond",
                        width: 18,
                        height: 18,
                        "border-width": 1.5,
                        "font-size": 8,
                        color: "#94a3b8",
                    },
                },
                {
                    selector: "node:selected",
                    style: {
                        "border-width": 3.5,
                        "border-color": "#0f172a",
                        width: 44,
                        height: 44,
                    },
                },
                {
                    selector: 'node[nodeKind = "transaction"]:selected',
                    style: {
                        width: 22,
                        height: 22,
                    },
                },
                {
                    selector: "node.highlighted",
                    style: {
                        "border-width": 3.5,
                        "border-color": "#0f172a",
                        width: 44,
                        height: 44,
                    },
                },
                {
                    selector: "node.center",
                    style: {
                        "border-width": 4,
                        "border-color": "#0f172a",
                        width: 50,
                        height: 50,
                        color: "#0f172a",
                        "font-weight": 700,
                    },
                },
                {
                    selector: "edge",
                    style: {
                        width: 1,
                        "line-color": "#cbd5e1",
                        "target-arrow-color": "#cbd5e1",
                        "target-arrow-shape": "triangle",
                        "curve-style": "bezier",
                        "arrow-scale": 0.9,
                        opacity: 0.7,
                    },
                },
                {
                    // SENT edge: entity → tx node
                    selector: 'edge[edgeKind = "SENT"]',
                    style: {
                        "line-color": "#86efac",
                        "target-arrow-color": "#86efac",
                        opacity: 0.8,
                        width: 1.5,
                    },
                },
                {
                    // RECEIVED edge: tx node → entity (carries the value)
                    selector: 'edge[edgeKind = "RECEIVED"]',
                    style: {
                        "line-color": "#86efac",
                        "target-arrow-color": "#86efac",
                        opacity: 0.8,
                        width: 1.5,
                    },
                },
            ],
            layout: {
                name: "fcose",
                animate: true,
                animationDuration: 600,
                animationEasing: "ease-out-cubic",
                randomize: true,
                nodeDimensionsIncludeLabels: true,
                idealEdgeLength: 120,
                nodeRepulsion: 5500,
                gravity: 0.2,
            } as any,
            minZoom: 0.1,
            maxZoom: 4,
        });

        cy.on("tap", "node", (evt) => onNodeSelect(evt.target.id()));
        cy.on("dbltap", "node", (evt) => onNodeExpand(evt.target.id()));

        if (data.center_address) {
            cy.getElementById(data.center_address).addClass("center");
        }

        cyRef.current = cy;
        return () => {
            cy.destroy();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;

        const currentIds = new Set(cy.elements().map((ele) => ele.id()));
        const newEls = toElements();
        const newIds = new Set(newEls.map((e) => e.data.id as string));

        cy.elements().forEach((ele) => {
            if (!newIds.has(ele.id())) ele.remove();
        });

        const toAdd = newEls.filter((e) => !currentIds.has(e.data.id as string));
        if (toAdd.length > 0) {
            cy.add(toAdd);
            cy.layout({
                name: "fcose",
                animate: true,
                animationDuration: 400,
                randomize: false,
                nodeDimensionsIncludeLabels: true,
                idealEdgeLength: 120,
                nodeRepulsion: 5500,
                gravity: 0.2,
            } as any).run();
        }

        cy.nodes().removeClass("center");
        if (data.center_address) {
            cy.getElementById(data.center_address).addClass("center");
        }
    }, [data, toElements]);

    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.nodes().removeClass("highlighted");
        if (selectedAddress) cy.getElementById(selectedAddress).addClass("highlighted");
    }, [selectedAddress]);

    return <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 400 }} />;
}
