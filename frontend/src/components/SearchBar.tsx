import { useState, FormEvent } from "react";

interface SearchBarProps {
    onSearch: (address: string) => void;
    onSearchTx?: (hash: string) => void;
    loading?: boolean;
}

function detectMode(value: string): "address" | "tx" | "unknown" {
    const v = value.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return "address";
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) return "tx";
    return "unknown";
}

const MODE_BADGE: Record<"address" | "tx", { label: string; cls: string }> = {
    address: { label: "Address", cls: "text-violet-600 border-violet-600" },
    tx:      { label: "Tx",      cls: "text-blue-600 border-blue-600" },
};

export function SearchBar({ onSearch, onSearchTx, loading }: SearchBarProps) {
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);

    const mode = detectMode(value);

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        const trimmed = value.trim().toLowerCase();

        if (mode === "address") {
            setError(null);
            onSearch(trimmed);
        } else if (mode === "tx") {
            setError(null);
            onSearchTx?.(trimmed);
        } else {
            if (!trimmed.startsWith("0x")) {
                setError("Must start with 0x");
            } else if (trimmed.length < 42) {
                setError("Too short — address (42 chars) or tx hash (66 chars)");
            } else if (trimmed.length > 66) {
                setError("Too long — address is 42 chars, tx hash is 66 chars");
            } else {
                setError("Invalid hex — address (42 chars) or tx hash (66 chars)");
            }
        }
    };

    const badge = mode !== "unknown" ? MODE_BADGE[mode] : null;

    return (
        <form onSubmit={handleSubmit} className="relative flex items-center gap-2 flex-1 max-w-[580px]">
            <div className="relative flex-1">
                {/* Unified input shell */}
                <div
                    className={`flex items-center bg-white border rounded-lg shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-all focus-within:shadow-[0_0_0_3px_rgba(15,23,42,0.08)] ${
                        error
                            ? "border-red-400 focus-within:border-red-500"
                            : "border-gray-200 focus-within:border-gray-900"
                    }`}
                >
                    {/* Search icon */}
                    <span className="pl-2.5 text-gray-400 pointer-events-none shrink-0">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                    </span>

                    {/* Mode badge — shown inside shell, left of text, does not overlap */}
                    {badge && (
                        <span
                            className={`ml-2 shrink-0 px-1.5 py-[2px] rounded border text-[0.6rem] font-semibold uppercase tracking-wide leading-none ${badge.cls}`}
                        >
                            {badge.label}
                        </span>
                    )}

                    <input
                        id="address-search"
                        data-testid="address-search"
                        type="text"
                        value={value}
                        onChange={(e) => {
                            setValue(e.target.value);
                            setError(null);
                        }}
                        placeholder={badge ? "" : "Address (0x…42) or tx hash (0x…66)"}
                        className="flex-1 min-w-0 py-2 px-2.5 bg-transparent text-[0.8rem] font-mono text-gray-900 outline-none placeholder:text-gray-400 placeholder:font-sans"
                        disabled={loading}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                {error && (
                    <span className="absolute left-0 top-[calc(100%+4px)] text-[0.7rem] text-red-500 whitespace-nowrap">
                        {error}
                    </span>
                )}
            </div>

            <button
                type="submit"
                data-testid="address-search-submit"
                disabled={loading || !value.trim()}
                className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-[0.8rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0"
            >
                {loading ? (
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                    </svg>
                ) : (
                    <>
                        {mode === "tx" ? "Lookup" : "Analyse"}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                        </svg>
                    </>
                )}
            </button>
        </form>
    );
}
