import type { EntityType, RiskLevel } from "../../types";

export type Tone =
    | "neutral"
    | "info"
    | "success"
    | "warning"
    | "danger"
    | "accent";

export type BadgeVariant = "outline" | "soft" | "solid";

const OUTLINE: Record<Tone, string> = {
    neutral: "border border-gray-400 text-gray-600",
    info: "border border-sky-500 text-sky-600",
    success: "border border-green-500 text-green-600",
    warning: "border border-amber-500 text-amber-600",
    danger: "border border-red-500 text-red-600",
    accent: "border border-violet-500 text-violet-600",
};

const SOFT: Record<Tone, string> = {
    neutral: "border border-gray-200 bg-gray-50 text-gray-700",
    info: "border border-sky-200 bg-sky-50 text-sky-700",
    success: "border border-green-200 bg-green-50 text-green-700",
    warning: "border border-amber-200 bg-amber-50 text-amber-700",
    danger: "border border-red-200 bg-red-50 text-red-700",
    accent: "border border-violet-200 bg-violet-50 text-violet-700",
};

const SOLID: Record<Tone, string> = {
    neutral: "bg-gray-700 text-white",
    info: "bg-sky-600 text-white",
    success: "bg-green-600 text-white",
    warning: "bg-amber-600 text-white",
    danger: "bg-red-600 text-white",
    accent: "bg-violet-600 text-white",
};

export const DOT: Record<Tone, string> = {
    neutral: "bg-gray-500",
    info: "bg-sky-500",
    success: "bg-green-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
    accent: "bg-violet-500",
};

export function toneClasses(tone: Tone, variant: BadgeVariant): string {
    if (variant === "solid") return SOLID[tone];
    if (variant === "soft") return SOFT[tone];
    return OUTLINE[tone];
}

// ── Semantic mappings ────────────────────────────────────────────────────────

export const RISK_TONE: Record<RiskLevel, Tone> = {
    unknown: "neutral",
    low: "success",
    medium: "warning",
    high: "warning",
    critical: "danger",
};

export const ENTITY_TONE: Record<EntityType, Tone> = {
    EOA: "neutral",
    Contract: "accent",
    Mixer: "danger",
    LendingPool: "info",
    Bridge: "warning",
    DEX: "success",
    CEXHotWallet: "accent",
    Application: "accent",
    Unknown: "neutral",
};

export const RUN_STATUS_TONE = {
    queued: "warning",
    running: "info",
    completed: "success",
    failed: "danger",
} as const;

export const TASK_STATUS_TONE = {
    pending: "warning",
    running: "info",
    completed: "success",
    cancelled: "neutral",
} as const;

export const USER_ROLE_TONE = {
    admin: "accent",
    operator: "info",
    user: "success",
} as const;
