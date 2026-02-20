/**
 * App shell — navigation between pages.
 * Pages live in src/pages/, reusable UI in src/components/.
 */
import { useState } from "react";
import { SearchBar } from "./components/SearchBar";
import { GraphExplorerPage, DashboardPage, ETLTestPage } from "./pages";
import "./index.css";

type Page = "explorer" | "dashboard" | "etl-test";

function App() {
    const [page, setPage] = useState<Page>("explorer");
    const [searchTrigger, setSearchTrigger] = useState<string | null>(null);

    // Pass search down to the explorer page via a key-based trigger
    const handleSearch = (address: string) => {
        setPage("explorer");
        setSearchTrigger(address);
    };

    return (
        <div className="app-shell">
            {/* ── Navigation ── */}
            <nav className="nav">
                {/* Logo */}
                <a
                    className="nav-logo"
                    href="/"
                    onClick={(e) => {
                        e.preventDefault();
                        setPage("explorer");
                    }}
                >
                    <span className="nav-logo-icon">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <circle cx="7" cy="7" r="2.5" fill="white" />
                            <circle cx="2" cy="2" r="1.5" fill="white" opacity="0.6" />
                            <circle cx="12" cy="2" r="1.5" fill="white" opacity="0.6" />
                            <circle cx="2" cy="12" r="1.5" fill="white" opacity="0.6" />
                            <circle cx="12" cy="12" r="1.5" fill="white" opacity="0.6" />
                            <line x1="7" y1="7" x2="2" y2="2" stroke="white" strokeWidth="0.8" opacity="0.4" />
                            <line x1="7" y1="7" x2="12" y2="2" stroke="white" strokeWidth="0.8" opacity="0.4" />
                            <line x1="7" y1="7" x2="2" y2="12" stroke="white" strokeWidth="0.8" opacity="0.4" />
                            <line x1="7" y1="7" x2="12" y2="12" stroke="white" strokeWidth="0.8" opacity="0.4" />
                        </svg>
                    </span>
                    Chain Analysis
                </a>

                {/* Search */}
                <SearchBar onSearch={handleSearch} />

                {/* Right side */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {/* ETL Test nav link */}
                    <button
                        onClick={() => setPage((p) => (p === "etl-test" ? "explorer" : "etl-test"))}
                        className="btn btn-secondary"
                        style={{ padding: "5px 12px" }}
                    >
                        <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                        </svg>
                        ETL Test
                    </button>

                    {/* Dashboard nav link */}
                    <button
                        onClick={() => setPage((p) => (p === "dashboard" ? "explorer" : "dashboard"))}
                        className="btn btn-secondary"
                        style={{ padding: "5px 12px" }}
                    >
                        <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <rect x="3" y="3" width="7" height="7" />
                            <rect x="14" y="3" width="7" height="7" />
                            <rect x="14" y="14" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" />
                        </svg>
                        Dashboard
                    </button>

                    {/* Live badge */}
                    <div className="nav-badge">
                        <span className="nav-badge-dot" />
                        Live Network
                    </div>
                </div>
            </nav>

            {/* ── Pages ── */}
            <GraphExplorerPage initialAddress={searchTrigger} onAddressLoad={() => setSearchTrigger(null)} />

            {/* Dashboard overlay (rendered on top when active) */}
            {page === "dashboard" && <DashboardPage onClose={() => setPage("explorer")} />}

            {/* ETL Test overlay */}
            {page === "etl-test" && <ETLTestPage onClose={() => setPage("explorer")} />}
        </div>
    );
}

export default App;
