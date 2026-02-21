import { Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Footer } from "./components/Footer";
import { Toaster } from "./components/Toaster";
import { GraphExplorerPage, DashboardPage, ETLPage, GroupsPage, HomePage } from "./pages";
import { ToastContext } from "./context/ToastContext";
import { useToast } from "./hooks/useToast";
import "./index.css";

function ExplorerRoute() {
    const [params, setParams] = useSearchParams();
    const address = params.get("address");
    return (
        <GraphExplorerPage
            initialAddress={address}
            onAddressLoad={() => {
                if (address) setParams({}, { replace: true });
            }}
        />
    );
}

function App() {
    const toast = useToast();
    const navigate = useNavigate();

    return (
        <ToastContext.Provider value={toast}>
            <Nav />
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route
                    path="/*"
                    element={
                        <div className="app-shell">
                            <Routes>
                                <Route path="/explorer" element={<ExplorerRoute />} />
                                <Route
                                    path="/groups"
                                    element={
                                        <GroupsPage
                                            onNavigateToExplorer={(addr) =>
                                                navigate(`/explorer?address=${encodeURIComponent(addr)}`)
                                            }
                                        />
                                    }
                                />
                                <Route path="/etl" element={<ETLPage />} />
                                <Route path="/dashboard" element={<DashboardPage />} />
                                <Route path="*" element={<Navigate to="/" replace />} />
                            </Routes>
                        </div>
                    }
                />
            </Routes>
            <Footer />
            <Toaster />
        </ToastContext.Provider>
    );
}

export default App;
