import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { SearchBar } from "./SearchBar";
import { LogoIcon, ExplorerIcon, GroupsIcon, EtlIcon, DashboardIcon } from "./NavIcons";
import { useAuth } from "../context/AuthContext";

const NAV_TABS = [
    { to: "/explorer", label: "Explorer", icon: <ExplorerIcon /> },
    { to: "/groups", label: "Groups", icon: <GroupsIcon /> },
    { to: "/etl", label: "ETL", icon: <EtlIcon /> },
    { to: "/dashboard", label: "Dashboard", icon: <DashboardIcon /> },
] as const;

export function Nav() {
    const navigate = useNavigate();
    const { user, isAuthenticated, logout } = useAuth();

    function handleLogout() {
        logout();
        navigate("/login", { replace: true });
    }

    // User initials avatar
    const initials = user ? user.username.slice(0, 2).toUpperCase() : "";

    return (
        <nav className="flex items-center justify-between px-6 h-14 bg-[rgba(249,250,251,0.92)] border-b border-gray-200 backdrop-blur-md sticky top-0 z-50">
            <NavLink
                className="flex items-center gap-2.5 font-bold text-base text-gray-900 no-underline tracking-tight"
                to="/"
                end
            >
                <span className="w-7 h-7 bg-gray-900 rounded-[4px] flex items-center justify-center">
                    <LogoIcon />
                </span>
                Chain Analysis
            </NavLink>

            <Routes>
                <Route
                    path="/explorer"
                    element={
                        <SearchBar onSearch={(addr) => navigate(`/explorer?address=${encodeURIComponent(addr)}`)} />
                    }
                />
                <Route path="*" element={null} />
            </Routes>

            <div className="flex items-center gap-3">
                {isAuthenticated && (
                    <div className="flex items-center gap-0.5">
                        {NAV_TABS.map((tab) => (
                            <NavLink
                                key={tab.to}
                                to={tab.to}
                                className={({ isActive }) =>
                                    `flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[0.8rem] font-medium transition-all whitespace-nowrap no-underline ` +
                                    (isActive
                                        ? "text-gray-900 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] border border-gray-200"
                                        : "text-gray-500 hover:text-gray-900 hover:bg-gray-100/80")
                                }
                            >
                                {tab.icon}
                                {tab.label}
                            </NavLink>
                        ))}
                    </div>
                )}
                {isAuthenticated && (
                    <div className="flex items-center gap-2">
                        {/* Live indicator */}
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-gray-200 bg-white text-[0.7rem] font-medium text-gray-500 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            Live Network
                        </div>
                        {/* User avatar */}
                        <div className="flex items-center gap-2 pl-1 border-l border-gray-200">
                            <div className="w-7 h-7 rounded-full bg-gray-900 flex items-center justify-center text-white text-[0.65rem] font-bold shrink-0">
                                {initials}
                            </div>
                            <span className="text-[0.8rem] font-medium text-gray-700 hidden sm:block max-w-[100px] truncate">
                                {user?.username}
                            </span>
                            <button
                                onClick={handleLogout}
                                title="Sign out"
                                className="inline-flex items-center gap-1 px-2 py-1 text-[0.72rem] font-medium text-gray-500 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 hover:text-gray-900 transition-colors"
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                >
                                    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                                    <polyline points="16 17 21 12 16 7" />
                                    <line x1="21" y1="12" x2="9" y2="12" />
                                </svg>
                                Sign out
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </nav>
    );
}
