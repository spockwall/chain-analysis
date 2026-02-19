/**
 * Dashboard component showing system health and statistics.
 */

import { useHealth } from "../hooks/useHealth";

interface DashboardProps {
    onClose: () => void;
}

export function Dashboard({ onClose }: DashboardProps) {
    const { health, loading, error, lastChecked, refresh } = useHealth({
        refreshInterval: 30000, // 30 seconds
    });

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-700">
                    <h2 className="text-lg font-semibold text-white">System Dashboard</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-white">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="p-4">
                    {/* Health Status */}
                    <div className="mb-6">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-medium text-gray-300">Service Health</h3>
                            <button
                                onClick={refresh}
                                disabled={loading}
                                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
                            >
                                {loading ? "Checking..." : "Refresh"}
                            </button>
                        </div>

                        {error && (
                            <div className="bg-red-500/20 text-red-400 px-3 py-2 rounded mb-3 text-sm">{error}</div>
                        )}

                        {health && (
                            <div className="grid grid-cols-2 gap-3">
                                {Object.entries(health.services).map(([service, healthy]) => (
                                    <div
                                        key={service}
                                        className="flex items-center gap-2 bg-gray-700/50 px-3 py-2 rounded"
                                    >
                                        <div
                                            className={`w-2 h-2 rounded-full ${
                                                healthy ? "bg-green-500" : "bg-red-500"
                                            }`}
                                        />
                                        <span className="text-sm text-gray-300 capitalize">{service}</span>
                                        <span
                                            className={`text-xs ml-auto ${healthy ? "text-green-400" : "text-red-400"}`}
                                        >
                                            {healthy ? "Healthy" : "Unhealthy"}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {lastChecked && (
                            <p className="text-xs text-gray-500 mt-2">
                                Last checked: {lastChecked.toLocaleTimeString()}
                            </p>
                        )}
                    </div>

                    {/* Overall Status */}
                    {health && (
                        <div className="mb-6">
                            <div
                                className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
                                    health.status === "healthy"
                                        ? "bg-green-500/20 text-green-400"
                                        : "bg-yellow-500/20 text-yellow-400"
                                }`}
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    {health.status === "healthy" ? (
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M5 13l4 4L19 7"
                                        />
                                    ) : (
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                        />
                                    )}
                                </svg>
                                <span className="font-medium">
                                    System Status:{" "}
                                    {health.status === "healthy" ? "All Systems Operational" : "Degraded"}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Quick Stats Placeholder */}
                    <div>
                        <h3 className="text-sm font-medium text-gray-300 mb-3">Quick Stats</h3>
                        <div className="grid grid-cols-3 gap-3">
                            <div className="bg-gray-700/50 px-4 py-3 rounded text-center">
                                <p className="text-2xl font-bold text-white">-</p>
                                <p className="text-xs text-gray-400">Total Entities</p>
                            </div>
                            <div className="bg-gray-700/50 px-4 py-3 rounded text-center">
                                <p className="text-2xl font-bold text-white">-</p>
                                <p className="text-xs text-gray-400">High Risk</p>
                            </div>
                            <div className="bg-gray-700/50 px-4 py-3 rounded text-center">
                                <p className="text-2xl font-bold text-white">-</p>
                                <p className="text-xs text-gray-400">Pending Labels</p>
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-2 text-center">
                            Connect to backend to see live statistics
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
