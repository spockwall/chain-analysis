/**
 * Cytoscape stylesheet for the graph canvas.
 */
// cytoscape's TS types for stylesheets are awkward; use any[] which is
// what cytoscape.use() and the style option accept at runtime.

// All entity nodes are this size — color alone distinguishes type.
const NODE_SIZE = 18;

// Group nodes are scaled up so they stand out from regular entity nodes.
const GROUP_NODE_SIZE = 34;

// Inflow = money received by the center node (edge points INTO center).
// Outflow = money sent by the center node (edge originates from center).
// Hex values match FLOW_COLORS in constants.ts; the trailing alpha keeps
// the canvas readable without making the colors look painted-on.
const EDGE_COLOR_INCOMING = "#10b98199"; // emerald-500 with alpha — inflow
const EDGE_COLOR_OUTGOING = "#f9731699"; // orange-500 with alpha  — outflow
const EDGE_COLOR_PATH = "#3b82f6"; // blue-500
const EDGE_COLOR_DEFAULT = "#e2e8f0"; // slate-200

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GRAPH_STYLESHEET: any[] = [
    {
        // Base entity node — uniform size, color = entity type
        selector: "node",
        style: {
            "background-color": "data(bgColor)",
            "border-width": 0,
            label: "data(label)",
            color: "#64748b", // desaturated label text
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 6,
            "font-size": 10,
            "font-family": "SF Mono, Fira Code, Cascadia Code, monospace",
            "font-weight": 400,
            "text-background-color": "#ffffff",
            "text-background-opacity": 0,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-wrap": "wrap",
            "text-max-width": "80px",
            width: NODE_SIZE,
            height: NODE_SIZE,
            "transition-property": "border-width, border-color, width, height",
            "transition-duration": 200,
        },
    },
    {
        // Selected — no ring, just shadow or slight scale could be added later if needed
        selector: "node:selected",
        style: {
            "border-width": 0,
        },
    },
    {
        // Highlighted (NodePanel focus) — no ring
        selector: "node.highlighted",
        style: {
            "border-width": 0,
        },
    },
    {
        // Center node of the current query
        selector: "node.center",
        style: {
            "font-weight": 400,
            "font-size": 11,
            color: "#333a4dff",
        },
    },
    {
        selector: "edge",
        style: {
            width: 1,
            "line-color": EDGE_COLOR_DEFAULT,
            "target-arrow-color": EDGE_COLOR_DEFAULT,
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.7,
            opacity: 0.5,
        },
    },
    {
        // Transfer edges
        selector: 'edge[edgeKind="TRANSFER"]',
        style: {
            "curve-style": "unbundled-bezier",
            "control-point-distances": "data(controlPointDistance)",
            "control-point-weights": 0.5,
            width: 1.2,
            "line-color": EDGE_COLOR_INCOMING,
            "target-arrow-color": EDGE_COLOR_INCOMING,
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.65,
            opacity: 0.6,
            // Label — horizontal pill
            label: "data(label)",
            "font-size": 9,
            "font-family": "SF Mono, Fira Code, Cascadia Code, monospace",
            "font-weight": 400,
            color: "#94a3b8",
            "text-rotation": "none",
            "text-halign": "center",
            "text-valign": "center",
            "text-background-opacity": 0,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-border-color": "#f1f5f9",
            "text-border-width": 1,
        } as any,
    },
    {
        // Outgoing edges from center node
        selector: 'edge[edgeKind="TRANSFER"][?isOutgoing]',
        style: {
            "line-color": EDGE_COLOR_OUTGOING,
            "target-arrow-color": EDGE_COLOR_OUTGOING,
        },
    },
    {
        // Path highlight — blue ring
        selector: "edge.on-path",
        style: {
            "line-color": EDGE_COLOR_PATH,
            "target-arrow-color": EDGE_COLOR_PATH,
            width: 2,
            opacity: 1,
            "z-index": 10,
        } as any,
    },
    {
        selector: "node.on-path",
        style: {
            "border-width": 0,
        },
    },
    {
        // Address search highlight — no ring
        selector: "node.search-match",
        style: {
            "border-width": 0,
        },
    },
    {
        // Self-loop edges
        selector: "edge[source=target]",
        style: {
            "curve-style": "loop",
            "loop-direction": "-45deg",
            "loop-sweep": "45deg",
        } as any,
    },
    {
        // Selected edge highlight
        selector: "edge.edge-selected",
        style: {
            "line-color": "#7e80d5ff",
            "target-arrow-color": "#7e80d5ff",
            opacity: 1,
            "z-index": 20,
        } as any,
    },
    {
        // Group node — entity that aggregates multiple contract members.
        // Rendered larger than regular nodes with a vivid violet border so it
        // stands out at a glance in the canvas.
        selector: 'node[nodeKind="group"]',
        style: {
            width: GROUP_NODE_SIZE,
            height: GROUP_NODE_SIZE,
            "border-width": 3,
            "border-color": "#7c3aed",   // violet-700 — vivid group accent
            "border-style": "solid",
            "background-opacity": 1,
            // Slightly larger, bolder label for the multi-line text
            "font-size": 10,
            "font-weight": 600,
            color: "#4c1d95",            // violet-900 — readable on light bg
            "text-margin-y": 8,
            "text-max-width": "90px",
        } as any,
    },
];
