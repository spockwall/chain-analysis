import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { SearchBar } from "./SearchBar";
import { LogoIcon, ExplorerIcon, GroupsIcon, EtlIcon, DashboardIcon } from "./NavIcons";

const NAV_TABS = [
    { to: "/explorer", label: "Explorer", icon: <ExplorerIcon /> },
    { to: "/groups",   label: "Groups",   icon: <GroupsIcon /> },
    { to: "/etl",      label: "ETL",      icon: <EtlIcon /> },
    { to: "/dashboard",label: "Dashboard",icon: <DashboardIcon /> },
] as const;

export function Nav() {
    const navigate = useNavigate();

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
                        <SearchBar
                            onSearch={(addr) =>
                                navigate(`/explorer?address=${encodeURIComponent(addr)}`)
                            }
                        />
                    }
                />
                <Route path="*" element={null} />
            </Routes>

            <div className="flex items-center gap-3">
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
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-gray-200 bg-white text-[0.7rem] font-medium text-gray-500 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Live Network
                </div>
            </div>
        </nav>
    );
}
