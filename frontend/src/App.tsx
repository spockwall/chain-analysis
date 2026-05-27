import { Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Footer } from "./components/Footer";
import { Toaster } from "./components/Toaster";
import {
    AdminUsersPage,
    CriminalDatasetPage,
    GraphExplorerPage,
    DashboardPage,
    ETLPage,
    GroupsPage,
    HomePage,
    LabelsPage,
    LoginPage,
    SignupPage,
} from "./pages";
import { ToastContext } from "./context/ToastContext";
import { useToast } from "./hooks/useToast";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { IngestionRunsProvider } from "./context/IngestionRunsContext";
import "./index.css";

function ExplorerRoute() {
    const [params] = useSearchParams();
    const address = params.get("address");
    const tx = params.get("tx");
    // Keep the address/tx in the URL so a refresh restores the same view.
    return <GraphExplorerPage initialAddress={address} initialTxHash={tx} />;
}

/** Redirects to /login if not authenticated (waits for auth to load). */
function ProtectedRoute({ children, allowedRoles }: { children: React.ReactNode; allowedRoles?: string[] }) {
    const { isAuthenticated, loading, user } = useAuth();
    if (loading) {
        // Brief loading state while the JWT is being verified
        return (
            <div className="flex-1 flex items-center justify-center">
                <svg className="animate-spin w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
            </div>
        );
    }
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    if (allowedRoles && user && !allowedRoles.includes(user.role)) {
        return <Navigate to="/dashboard" replace />;
    }
    return <>{children}</>;
}

function App() {
    const toast = useToast();
    const navigate = useNavigate();

    return (
        <AuthProvider>
            <ToastContext.Provider value={toast}>
                <IngestionRunsProvider>
                <Nav />
                <Routes>
                    {/* Public routes */}
                    <Route path="/" element={<HomePage />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/signup" element={<SignupPage />} />

                    {/* Protected app routes */}
                    <Route
                        path="/*"
                        element={
                            <div className="app-shell">
                                <Routes>
                                    <Route
                                        path="/explorer"
                                        element={
                                            <ProtectedRoute>
                                                <ExplorerRoute />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route
                                        path="/groups"
                                        element={
                                            <ProtectedRoute>
                                                <GroupsPage
                                                    onNavigateToExplorer={(addr) =>
                                                        navigate(`/explorer?address=${encodeURIComponent(addr)}`)
                                                    }
                                                />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route
                                        path="/labels"
                                        element={
                                            <ProtectedRoute>
                                                <LabelsPage />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route
                                        path="/criminal-dataset"
                                        element={
                                            <ProtectedRoute>
                                                <CriminalDatasetPage />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route
                                        path="/etl"
                                        element={
                                            <ProtectedRoute>
                                                <ETLPage />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route
                                        path="/dashboard"
                                        element={
                                            <ProtectedRoute>
                                                <DashboardPage />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route
                                        path="/admin/users"
                                        element={
                                            <ProtectedRoute allowedRoles={["admin"]}>
                                                <AdminUsersPage />
                                            </ProtectedRoute>
                                        }
                                    />
                                    <Route path="*" element={<Navigate to="/" replace />} />
                                </Routes>
                            </div>
                        }
                    />
                </Routes>
                <Footer />
                <Toaster />
                </IngestionRunsProvider>
            </ToastContext.Provider>
        </AuthProvider>
    );
}

export default App;
