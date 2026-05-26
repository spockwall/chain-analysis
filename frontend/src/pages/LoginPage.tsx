/**
 * Login page — matches the existing grid-background + white card design.
 */
import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useToastContext } from "../context/ToastContext";
import { DotCube } from "../components/DotCube";
import { Background } from "../components/Background";
import { inputCls, btnPrimary } from "@/constants";

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
        <Background useDotCube={false}>
            {/* Card */}
            <div className="z-10 w-full max-w-[400px] bg-white border border-gray-200 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] overflow-hidden">
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
                            data-testid="login-email"
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
                                data-testid="login-password"
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
                    <button
                        id="login-submit"
                        data-testid="login-submit"
                        type="submit"
                        className={`${btnPrimary} mt-1`}
                        disabled={loading}
                    >
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
            <p className="z-10 text-[0.7rem] text-gray-400 mt-6">Chain Analysis · AML Intelligence Platform</p>
        </Background>
    );
}
