/**
 * App shell — navbar with tab navigation between pages.
 * Pages: Explorer | ETL | Dashboard
 */
import { useState } from "react";
import { SearchBar } from "./components/SearchBar";
import { Toaster } from "./components/Toaster";
import { GraphExplorerPage, DashboardPage, ETLPage, GroupsPage } from "./pages";
import { ToastContext } from "./context/ToastContext";
import { useToast } from "./hooks/useToast";
import "./index.css";

type Page = "explorer" | "etl" | "dashboard" | "groups";

// ── Nav tab icons ─────────────────────────────────────────────────────────────

function ExplorerIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    );
}

function EtlIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
    );
}

function DashboardIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
        </svg>
    );
}

function GroupsIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="7" width="20" height="14" rx="2" />
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            <line x1="12" y1="12" x2="12" y2="16" />
            <line x1="10" y1="14" x2="14" y2="14" />
        </svg>
    );
}

function LogoIcon() {
    return (
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
    );
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
    const [page, setPage] = useState<Page>("explorer");
    const [searchTrigger, setSearchTrigger] = useState<string | null>(null);
    const toast = useToast();

    const handleSearch = (address: string) => {
        setPage("explorer");
        setSearchTrigger(address);
    };

    const tabs: { id: Page; label: string; icon: React.ReactNode }[] = [
        { id: "explorer", label: "Explorer", icon: <ExplorerIcon /> },
        { id: "groups", label: "Groups", icon: <GroupsIcon /> },
        { id: "etl", label: "ETL", icon: <EtlIcon /> },
        { id: "dashboard", label: "Dashboard", icon: <DashboardIcon /> },
    ];

    return (
        <ToastContext.Provider value={toast}>
            <div className="app-shell">
                {/* ── Navigation ── */}
                <nav className="nav">
                    <a
                        className="nav-logo"
                        href="/"
                        onClick={(e) => {
                            e.preventDefault();
                            setPage("explorer");
                        }}
                    >
                        <span className="nav-logo-icon">
                            <LogoIcon />
                        </span>
                        Chain Analysis
                    </a>

                    {page === "explorer" && <SearchBar onSearch={handleSearch} />}

                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div className="nav-tabs">
                            {tabs.map((tab) => (
                                <button
                                    key={tab.id}
                                    onClick={() => setPage(tab.id)}
                                    className={`nav-tab ${page === tab.id ? "active" : ""}`}
                                >
                                    {tab.icon}
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                        <div className="nav-badge">
                            <span className="nav-badge-dot" />
                            Live Network
                        </div>
                    </div>
                </nav>

                {/* ── Pages ── */}
                {page === "explorer" && (
                    <GraphExplorerPage initialAddress={searchTrigger} onAddressLoad={() => setSearchTrigger(null)} />
                )}
                {page === "groups" && (
                    <GroupsPage
                        onNavigateToExplorer={(addr) => {
                            setPage("explorer");
                            setSearchTrigger(addr);
                        }}
                    />
                )}
                {page === "etl" && <ETLPage />}
                {page === "dashboard" && <DashboardPage />}
            </div>

            {/* Global toast stack — bottom-right */}
            <Toaster />
        </ToastContext.Provider>
    );
}

export default App;
