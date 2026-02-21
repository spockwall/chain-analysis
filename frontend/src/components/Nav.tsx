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
        <nav className="nav">
            <NavLink className="nav-logo" to="/" end>
                <span className="nav-logo-icon"><LogoIcon /></span>
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

            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="nav-tabs">
                    {NAV_TABS.map((tab) => (
                        <NavLink
                            key={tab.to}
                            to={tab.to}
                            className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}
                        >
                            {tab.icon}
                            {tab.label}
                        </NavLink>
                    ))}
                </div>
                <div className="nav-badge">
                    <span className="nav-badge-dot" />
                    Live Network
                </div>
            </div>
        </nav>
    );
}
