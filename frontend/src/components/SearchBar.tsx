import { useState, FormEvent } from "react";

interface SearchBarProps {
    onSearch: (address: string) => void;
    loading?: boolean;
}

export function SearchBar({ onSearch, loading }: SearchBarProps) {
    const [address, setAddress] = useState("");
    const [error, setError] = useState<string | null>(null);

    const validate = (addr: string): boolean => {
        if (!addr.startsWith("0x")) {
            setError("Must start with 0x");
            return false;
        }
        if (addr.length !== 42) {
            setError("Must be 42 characters");
            return false;
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            setError("Invalid hex address");
            return false;
        }
        setError(null);
        return true;
    };

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        const trimmed = address.trim().toLowerCase();
        if (validate(trimmed)) onSearch(trimmed);
    };

    return (
        <form onSubmit={handleSubmit} className="relative flex items-center gap-2 flex-1 max-w-[560px]">
            {/* Search icon */}
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
            </span>

            <div className="relative flex-1">
                <input
                    id="address-search"
                    type="text"
                    value={address}
                    onChange={(e) => {
                        setAddress(e.target.value);
                        setError(null);
                    }}
                    placeholder="Enter Ethereum address  0x..."
                    className={`w-full py-2 pl-9 pr-3 bg-white border rounded-lg text-[0.8rem] font-mono text-gray-900 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-all outline-none placeholder:text-gray-400 placeholder:font-sans focus:shadow-[0_0_0_3px_rgba(15,23,42,0.08)] ${
                        error
                            ? "border-red-500 focus:border-red-500"
                            : "border-gray-200 focus:border-gray-900"
                    }`}
                    disabled={loading}
                    autoComplete="off"
                    spellCheck={false}
                />
                {error && (
                    <span className="absolute left-0 top-[calc(100%+4px)] text-[0.7rem] text-red-500 whitespace-nowrap">
                        {error}
                    </span>
                )}
            </div>

            <button
                type="submit"
                disabled={loading || !address.trim()}
                className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-[0.8rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0"
            >
                {loading ? (
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                    </svg>
                ) : (
                    <>
                        Analyse
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
