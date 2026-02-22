/**
 * Login page — matches the existing grid-background + white card design.
 */
import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useToastContext } from "../context/ToastContext";

const inputCls =
    "w-full px-3 py-2.5 border border-gray-200 rounded-lg bg-white text-[0.85rem] text-gray-900 font-[inherit] outline-none transition-all focus:border-indigo-500 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.12)] placeholder:text-gray-400";

const btnPrimary =
    "w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-[0.9rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0";

export function LoginPage() {
    const { login, isAuthenticated } = useAuth();
    const toast = useToastContext();
    const navigate = useNavigate();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    // Already logged in → redirect away
    useEffect(() => {
        if (isAuthenticated) navigate("/explorer", { replace: true });
    }, [isAuthenticated, navigate]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!email.trim() || !password) {
            toast.error("Please enter your email and password");
            return;
        }
        setLoading(true);
        try {
            await login(email.trim(), password);
            toast.success("Welcome back!");
            navigate("/explorer", { replace: true });
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Invalid credentials");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div
            className="min-h-screen flex flex-col items-center justify-center px-4 font-[Outfit,Inter,sans-serif]"
            style={{
                backgroundColor: "#f5f5f5",
                backgroundImage:
                    "linear-gradient(#e2e2e2 1px, transparent 1px), linear-gradient(90deg, #e2e2e2 1px, transparent 1px)",
                backgroundSize: "48px 48px",
            }}
        >
            {/* Logo link */}
            <Link
                to="/"
                className="flex items-center gap-2.5 font-bold text-base text-gray-900 no-underline tracking-tight mb-8"
            >
                <span className="w-8 h-8 bg-gray-900 rounded-[5px] flex items-center justify-center">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                </span>
                Chain Analysis
            </Link>

            {/* Card */}
            <div className="w-full max-w-[400px] bg-white border border-gray-200 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] overflow-hidden">
                {/* Header */}
                <div className="px-7 pt-7 pb-5 border-b border-gray-100">
                    <p className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 mb-1">
                        Authentication
                    </p>
                    <h1 className="text-[1.5rem] font-bold tracking-tight text-gray-900 m-0">Sign in</h1>
                    <p className="text-[0.82rem] text-gray-500 mt-1 mb-0">Access the AML investigation platform</p>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="px-7 py-6 flex flex-col gap-4">
                    {/* Email */}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400">
                            Email
                        </label>
                        <input
                            id="login-email"
                            type="email"
                            autoComplete="email"
                            className={inputCls}
                            placeholder="analyst@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>

                    {/* Password */}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400">
                            Password
                        </label>
                        <div className="relative">
                            <input
                                id="login-password"
                                type={showPassword ? "text" : "password"}
                                autoComplete="current-password"
                                className={`${inputCls} pr-10`}
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                            <button
                                type="button"
                                tabIndex={-1}
                                onClick={() => setShowPassword((v) => !v)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 transition-colors"
                            >
                                {showPassword ? (
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                                        <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                    </svg>
                                ) : (
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                        <circle cx="12" cy="12" r="3" />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Submit */}
                    <button id="login-submit" type="submit" className={`${btnPrimary} mt-1`} disabled={loading}>
                        {loading ? (
                            <>
                                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                                    <circle
                                        className="opacity-25"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="white"
                                        strokeWidth="4"
                                    />
                                    <path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8v8H4z" />
                                </svg>
                                Signing in…
                            </>
                        ) : (
                            "Sign in →"
                        )}
                    </button>
                </form>

                {/* Footer */}
                <div className="px-7 pb-6 flex items-center justify-center gap-1.5">
                    <span className="text-[0.8rem] text-gray-400">Don't have an account?</span>
                    <Link
                        to="/signup"
                        className="text-[0.8rem] font-semibold text-gray-900 no-underline hover:underline"
                    >
                        Sign up
                    </Link>
                </div>
            </div>

            {/* Subtle footer */}
            <p className="text-[0.7rem] text-gray-400 mt-6">Chain Analysis · AML Intelligence Platform</p>
        </div>
    );
}
