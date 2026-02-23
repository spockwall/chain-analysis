import { useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate, useLocation } from "react-router-dom";
import { SearchBar } from "./SearchBar";
import { LogoIcon, ExplorerIcon, GroupsIcon, EtlIcon, DashboardIcon } from "./NavIcons";
import { useAuth } from "../context/AuthContext";

const NAV_TABS = [
    { to: "/explorer", label: "Explorer", icon: <ExplorerIcon /> },
    { to: "/groups", label: "Groups", icon: <GroupsIcon /> },
    { to: "/etl", label: "ETL", icon: <EtlIcon /> },
    { to: "/dashboard", label: "Dashboard", icon: <DashboardIcon /> },
] as const;

// Role accent — a small coloured dot only
const ROLE_DOT: Record<string, string> = {
    admin: "bg-violet-500",
    operator: "bg-sky-500",
    user: "bg-emerald-500",
};
const ROLE_LABEL: Record<string, string> = {
    admin: "Admin",
    operator: "Operator",
    user: "User",
};

// ── Add future menu items here ─────────────────────────────────────────────
const MENU_ITEMS: Array<{
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
}> = [];

export function Nav() {
    const navigate = useNavigate();
    const location = useLocation();
    const { user, isAuthenticated, logout } = useAuth();
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const initials = user ? user.username.slice(0, 2).toUpperCase() : "";
    const roleDot = ROLE_DOT[user?.role ?? "user"] ?? ROLE_DOT.user;
    const roleLabel = ROLE_LABEL[user?.role ?? "user"] ?? "User";

    useEffect(() => {
        function onOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", onOutside);
        return () => document.removeEventListener("mousedown", onOutside);
    }, []);

    function handleLogout() {
        setOpen(false);
        logout();
        navigate("/login", { replace: true });
    }

    return (
        <nav className="flex items-center justify-between px-6 h-14 bg-[rgba(249,250,251,0.92)] border-b border-gray-200 backdrop-blur-md sticky top-0 z-50">
            {/* Logo */}
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

            {/* Search bar (explorer route only) */}
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
                {/* Nav tabs */}
                {isAuthenticated && (
                    <div className="flex items-center gap-0.5">
                        {NAV_TABS.map((tab) => (
                            <NavLink
                                key={tab.to}
                                to={tab.to}
                                className={({ isActive }) =>
                                    "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[0.8rem] font-medium transition-all whitespace-nowrap no-underline " +
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

                {/* Live indicator + user dropdown */}
                {isAuthenticated && (
                    <div className="flex items-center gap-2">
                        {/* Dropdown root */}
                        <div className="relative" ref={menuRef}>
                            {/* Trigger */}
                            <button
                                id="user-menu-trigger"
                                onClick={() => setOpen((v) => !v)}
                                aria-expanded={open}
                                aria-haspopup="true"
                                className={`flex items-center gap-2 pl-1 pr-2 py-1 rounded-full border transition-all duration-150 ${
                                    open
                                        ? "border-gray-300 bg-white shadow-[0_1px_4px_rgba(15,23,42,0.08)]"
                                        : "border-transparent hover:border-gray-200 hover:bg-white hover:shadow-[0_1px_4px_rgba(15,23,42,0.06)]"
                                }`}
                            >
                                {/* Avatar */}
                                <div className="w-7 h-7 rounded-full bg-gray-900 flex items-center justify-center text-white text-[0.65rem] font-bold shrink-0 tracking-wider">
                                    {initials}
                                </div>
                                {/* Username */}
                                <span className="text-[0.8rem] font-medium text-gray-700 hidden sm:block max-w-[80px] truncate leading-none">
                                    {user?.username}
                                </span>
                                {/* Chevron */}
                                <svg
                                    width="11"
                                    height="11"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    className={`text-gray-400 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                                >
                                    <polyline points="6 9 12 15 18 9" />
                                </svg>
                            </button>

                            {/* ── Dropdown panel ─────────────────────────────── */}
                            {open && (
                                <div
                                    id="user-menu-dropdown"
                                    style={{
                                        boxShadow: "0 4px 6px -1px rgba(0,0,0,0.07), 0 16px 32px -4px rgba(0,0,0,0.12)",
                                    }}
                                    className="absolute right-0 top-[calc(100%+6px)] w-60 bg-white border border-gray-200/80 rounded-2xl overflow-hidden z-50"
                                >
                                    {/* Header — avatar + info */}
                                    <div className="px-4 pt-4 pb-3 flex items-start gap-3">
                                        <div className="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center text-white text-[0.75rem] font-bold shrink-0 tracking-wider mt-0.5">
                                            {initials}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-[0.85rem] font-semibold text-gray-900 leading-snug truncate">
                                                {user?.username}
                                            </p>
                                            <p className="text-[0.72rem] text-gray-400 truncate mt-0.5">
                                                {user?.email}
                                            </p>
                                            {/* Role pill */}
                                            <div className="flex items-center gap-1.5 mt-2">
                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${roleDot}`} />
                                                <span className="text-[0.68rem] font-semibold text-gray-500 uppercase tracking-wider">
                                                    {roleLabel}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Divider */}
                                    <div className="mx-3 border-t border-gray-100" />

                                    {/* Dynamic menu items */}
                                    {MENU_ITEMS.length > 0 && (
                                        <>
                                            <div className="p-1.5">
                                                {MENU_ITEMS.map((item) => (
                                                    <button
                                                        key={item.label}
                                                        onClick={() => {
                                                            setOpen(false);
                                                            item.onClick();
                                                        }}
                                                        className="w-full flex items-center gap-2.5 px-3 py-2 text-[0.8rem] text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-left"
                                                    >
                                                        {item.icon}
                                                        {item.label}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="mx-3 border-t border-gray-100" />
                                        </>
                                    )}

                                    {/* Sign out */}
                                    <div className="p-1.5">
                                        <button
                                            id="signout-button"
                                            onClick={handleLogout}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 text-[0.8rem] font-medium text-gray-500 rounded-lg hover:bg-gray-50 hover:text-gray-900 transition-colors text-left group"
                                        >
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                                className="shrink-0 text-gray-400 group-hover:text-gray-600 transition-colors"
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
                    </div>
                )}

                {/* Login link for unauthenticated users on home page */}
                {!isAuthenticated && location.pathname === "/" && (
                    <NavLink
                        to="/login"
                        className="px-4 py-1.5 rounded-full bg-gray-900 text-white text-[0.8rem] font-medium shadow-sm hover:bg-gray-800 transition-colors no-underline"
                    >
                        Sign in
                    </NavLink>
                )}
            </div>
        </nav>
    );
}
