/**
 * Shared UI constants — risk levels, entity types, colors, badge classes, button styles.
 * Import from here instead of redefining per-file.
 */
import type { EntityType, RiskLevel } from "./types";

// ── Enumerations ──────────────────────────────────────────────────────────────

export const RISK_LEVELS: RiskLevel[] = ["unknown", "low", "medium", "high", "critical"];

export const ENTITY_TYPES: EntityType[] = [
    "EOA",
    "Contract",
    "Mixer",
    "LendingPool",
    "Bridge",
    "DEX",
    "CEXHotWallet",
    "Application",
    "Unknown",
];

// ── Risk level colors (hex, for inline styles / Cytoscape) ───────────────────

export const RISK_COLOR: Record<RiskLevel, string> = {
    unknown: "#94a3b8",
    low: "#22c55e",
    medium: "#eab308",
    high: "#f97316",
    critical: "#ef4444",
};

// ── Risk level Tailwind badge classes (bg + text + border) ───────────────────

export const RISK_BADGE: Record<RiskLevel, string> = {
    unknown: "border border-slate-500 text-slate-500 ",
    low: "border border-green-500 text-green-500",
    medium: "border border-yellow-500 text-yellow-500",
    high: "border border-orange-500 text-orange-500",
    critical: "border border-red-500 text-red-500",
};

// ── Entity type node colors (hex, for Cytoscape bg) ──────────────────────────

export const ENTITY_COLORS: Record<EntityType, string> = {
    EOA:          "#475569", // slate-600
    Contract:     "#4f46e5", // indigo-600
    Mixer:        "#dc2626", // red-600
    LendingPool:  "#0284c7", // sky-600
    Bridge:       "#d97706", // amber-600
    DEX:          "#16a34a", // green-600
    CEXHotWallet: "#7c3aed", // violet-600
    Application:  "#db2777", // pink-600
    Unknown:      "#94a3b8", // slate-400
};

// ── Entity type human-readable labels ─────────────────────────────────────────

export const ENTITY_LABEL: Record<EntityType, string> = {
    EOA: "Externally Owned Account",
    Contract: "Smart Contract",
    Mixer: "Mixer",
    LendingPool: "Lending Pool",
    Bridge: "Bridge",
    DEX: "Decentralised Exchange",
    CEXHotWallet: "CEX Hot Wallet",
    Application: "Application",
    Unknown: "Unknown",
};

// ── Shared Tailwind class strings ─────────────────────────────────────────────

export const inputCls =
    "w-full px-2.5 py-[7px] border border-gray-200 rounded bg-white text-[0.8rem] text-gray-900 font-[inherit] outline-none transition-all focus:border-indigo-500 focus:shadow-[0_0_0_2px_rgba(99,102,241,0.15)]";

export const monoCls =
    "flex-1 px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-mono bg-white text-gray-900 outline-none transition-colors focus:border-gray-400";

export const selectCls =
    "px-2.5 py-[7px] border border-gray-200 rounded-lg text-[0.78rem] font-[inherit] bg-white text-gray-900 outline-none cursor-pointer";

export const sectionLabel = "text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-500 mb-1";

export const btnPrimary =
    "inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-[0.8rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0";

export const btnPrimarySm =
    "inline-flex items-center justify-center gap-1.5 px-2 py-1 bg-gray-900 text-white text-[0.7rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0";

export const btnGhost =
    "inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-transparent text-gray-500 text-[0.8rem] font-medium rounded-lg border border-gray-200 transition-all hover:bg-gray-50";

export const btnSecondary =
    "inline-flex items-center justify-center gap-1.5 px-3 py-[5px] bg-white text-gray-700 text-[0.72rem] font-medium rounded-lg border border-gray-200 cursor-pointer transition-colors hover:bg-gray-50 disabled:opacity-45 disabled:cursor-not-allowed";

export const btnDangerSm =
    "inline-flex items-center justify-center gap-1.5 px-2.5 py-1 bg-transparent text-red-600 text-[0.72rem] font-semibold rounded-lg border border-red-400 transition-all hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed";

export const btnDanger =
    "inline-flex items-center justify-center gap-1.5 px-4 py-[7px] bg-red-500 text-white text-[0.78rem] font-semibold rounded-lg border-none cursor-pointer shrink-0 transition-colors hover:bg-red-600 disabled:opacity-45 disabled:cursor-not-allowed";

export const propsBlock =
    "bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-[0.7rem] text-gray-500 overflow-x-auto";

export const labelCls = "px-2 py-[3px] border border-gray-500 rounded text-[0.7rem] text-gray-500";
