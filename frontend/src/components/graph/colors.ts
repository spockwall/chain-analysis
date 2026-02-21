/**
 * Color constants for graph nodes and edges.
 */
import type { EntityType, RiskLevel } from "../../types";

export const ENTITY_COLORS: Record<EntityType | "Unknown", { bg: string; border: string }> = {
    EOA: { bg: "#475569", border: "#475569" }, // slate-600
    Contract: { bg: "#4f46e5", border: "#4f46e5" }, // indigo-600 (slightly desaturated)
    Mixer: { bg: "#9c3636ff", border: "#991b1b" }, // red-800
    LendingPool: { bg: "#0369a1", border: "#0369a1" }, // sky-700
    Bridge: { bg: "#b45309", border: "#b45309" }, // amber-700
    DEX: { bg: "#15803d", border: "#15803d" }, // emerald-700
    CEXHotWallet: { bg: "#6d28d9", border: "#6d28d9" }, // violet-700
    Application: { bg: "#be185d", border: "#be185d" }, // pink-700
    Unknown: { bg: "#94a3b8", border: "#94a3b8" }, // slate-400
};

export const RISK_RING: Record<RiskLevel, string> = {
    unknown: "#94a3b8", // slate-400
    low: "#10b981", // emerald-500
    medium: "#f59e0b", // amber-500
    high: "#ef4444", // red-500
    critical: "#7f1d1d", // red-900
};

export const EDGE_COLOR_INCOMING = "#64748b88"; // slate-500 with alpha
export const EDGE_COLOR_OUTGOING = "#6080b088"; // slate-400 with alpha
export const EDGE_COLOR_PATH = "#3b82f6"; // blue-500
export const EDGE_COLOR_DEFAULT = "#e2e8f0"; // slate-200
