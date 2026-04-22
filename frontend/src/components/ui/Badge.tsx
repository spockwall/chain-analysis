import type { ReactNode } from "react";
import { toneClasses, type BadgeVariant, type Tone } from "./tokens";

interface BadgeProps {
    tone?: Tone;
    variant?: BadgeVariant;
    size?: "sm" | "md";
    className?: string;
    children: ReactNode;
}

const SIZE: Record<NonNullable<BadgeProps["size"]>, string> = {
    sm: "px-1.5 py-[1px] text-[0.6rem]",
    md: "px-2 py-0.5 text-[0.7rem]",
};

export function Badge({
    tone = "neutral",
    variant = "outline",
    size = "md",
    className = "",
    children,
}: BadgeProps): JSX.Element {
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-md font-semibold tracking-wide uppercase ${SIZE[size]} ${toneClasses(tone, variant)} ${className}`}
        >
            {children}
        </span>
    );
}
