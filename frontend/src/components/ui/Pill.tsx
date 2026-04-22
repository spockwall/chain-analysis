import type { ReactNode } from "react";
import { DOT, toneClasses, type BadgeVariant, type Tone } from "./tokens";

interface PillProps {
    tone?: Tone;
    variant?: BadgeVariant;
    dot?: boolean;
    dotPulse?: boolean;
    className?: string;
    children: ReactNode;
}

export function Pill({
    tone = "neutral",
    variant = "outline",
    dot = false,
    dotPulse = false,
    className = "",
    children,
}: PillProps): JSX.Element {
    return (
        <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[0.7rem] font-semibold tracking-wide uppercase ${toneClasses(tone, variant)} ${className}`}
        >
            {dot && (
                <span
                    className={`w-1.5 h-1.5 rounded-full ${DOT[tone]} ${dotPulse ? "animate-pulse" : ""}`}
                />
            )}
            {children}
        </span>
    );
}
