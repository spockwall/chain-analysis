/**
 * Reusable clipboard copy button used across panel components.
 *
 * Two variants:
 *  - "icon"  (default) — square icon button with a copy SVG, used in NodePanel address header
 *  - "text"            — plain text link style ("Copy hash ↗"), used in EdgePanel hash header
 */
interface CopyButtonProps {
    text: string;
    variant?: "icon" | "text";
    onCopy?: () => void;
    onError?: () => void;
}

export function CopyButton({ text, variant = "icon", onCopy, onError }: CopyButtonProps) {
    const handleClick = () => {
        navigator.clipboard
            .writeText(text)
            .then(() => onCopy?.())
            .catch(() => onError?.());
    };

    if (variant === "text") {
        return (
            <button
                className="font-mono text-[0.68rem] text-gray-400 bg-none border-none p-0 cursor-pointer text-left hover:text-gray-600"
                title="Copy to clipboard"
                onClick={handleClick}
            >
                Copy hash ↗
            </button>
        );
    }

    return (
        <button
            className="shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded bg-transparent border-none cursor-pointer text-gray-400 transition-colors hover:text-gray-700 p-0"
            title="Copy address"
            onClick={handleClick}
        >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
        </button>
    );
}
