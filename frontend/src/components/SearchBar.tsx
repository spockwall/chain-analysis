/**
 * Search bar — Oravia style
 */
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
        <form onSubmit={handleSubmit} className="search-wrap">
            {/* Search icon */}
            <span className="search-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
            </span>

            <div style={{ position: "relative", flex: 1 }}>
                <input
                    id="address-search"
                    type="text"
                    value={address}
                    onChange={(e) => {
                        setAddress(e.target.value);
                        setError(null);
                    }}
                    placeholder="Enter Ethereum address  0x..."
                    className={`search-input${error ? " error" : ""}`}
                    disabled={loading}
                    autoComplete="off"
                    spellCheck={false}
                />
                {error && <span className="search-error">{error}</span>}
            </div>

            <button
                type="submit"
                disabled={loading || !address.trim()}
                className="btn btn-primary"
                style={{ flexShrink: 0 }}
            >
                {loading ? (
                    <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                    </svg>
                ) : (
                    <>
                        Analyse
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                        >
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                        </svg>
                    </>
                )}
            </button>
        </form>
    );
}
