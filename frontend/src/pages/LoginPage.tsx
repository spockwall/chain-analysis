/**
 * Login page — split-screen design: dark branding panel (left) + login form (right).
 */
import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useToastContext } from "../context/ToastContext";
import { DotCube } from "../components/DotCube";
import { Background } from "../components/Background";
import { inputCls } from "@/constants";

const FEATURES = [
    { icon: "🔍", text: "Trace fund flows across EVM chains" },
    { icon: "🕸️", text: "Interactive property graph explorer" },
    { icon: "🚨", text: "Automated AML pattern detection" },
    { icon: "🏷️", text: "Analyst-driven entity labeling" },
];

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

    // min-h accounts for the fixed Nav + Footer height (~115px combined)
    return (
        <div className="min-h-[calc(100vh-115px)] flex font-[Outfit,Inter,sans-serif]">
            {/* ── Left: branding panel ─────────────────────────────────────── */}
            <div className="hidden lg:flex flex-col justify-between w-[45%] bg-gray-900 px-12 py-10 relative overflow-hidden">
                {/* Dot-cube decorations */}
                <DotCube className="absolute -top-10 -left-14 w-[520px] h-[420px] opacity-20 pointer-events-none" />
                <DotCube className="absolute -bottom-16 -right-16 w-[480px] h-[400px] opacity-15 pointer-events-none" />

                {/* Top: wordmark */}
                <div className="relative z-10">
                    <div className="inline-flex items-center gap-2.5">
                        {/* Hex-graph icon */}
                        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                            <circle cx="14" cy="14" r="13" stroke="#6366f1" strokeWidth="1.5" />
                            <circle cx="14" cy="8"  r="2.5" fill="#6366f1" />
                            <circle cx="8"  cy="18" r="2.5" fill="#6366f1" />
                            <circle cx="20" cy="18" r="2.5" fill="#6366f1" />
                            <line x1="14" y1="10.5" x2="8.8"  y2="16"   stroke="#6366f1" strokeWidth="1.2" />
                            <line x1="14" y1="10.5" x2="19.2" y2="16"   stroke="#6366f1" strokeWidth="1.2" />
                            <line x1="9.5" y1="18"  x2="18.5" y2="18"   stroke="#6366f1" strokeWidth="1.2" />
                        </svg>
                        <span className="text-white font-bold text-[1rem] tracking-tight">Chain Analysis</span>
                    </div>
                </div>

                {/* Middle: headline + features */}
                <div className="relative z-10 flex flex-col gap-8">
                    <div>
                        <h2 className="text-white text-[2.4rem] font-extrabold leading-[1.1] tracking-[-0.03em] m-0">
                            On-chain
                            <br />
                            <span className="text-indigo-400">intelligence.</span>
                        </h2>
                        <p className="text-gray-400 text-[0.88rem] leading-[1.65] mt-3 mb-0 max-w-[300px]">
                            The AML investigation platform built for analysts who need to follow the money.
                        </p>
                    </div>

                    <ul className="flex flex-col gap-3 list-none m-0 p-0">
                        {FEATURES.map(({ icon, text }) => (
                            <li key={text} className="flex items-center gap-3 text-gray-300 text-[0.83rem]">
                                <span className="text-base leading-none">{icon}</span>
                                {text}
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Bottom: subtle tagline */}
                <p className="relative z-10 text-[0.68rem] text-gray-600 m-0">
                    Chain Analysis · AML Intelligence Platform
                </p>
            </div>

        {/* ── Right: form panel ────────────────────────────────────────── */}
        {/* Background reuses the same grid-dot style as other public pages (nav + footer = 115px) */}
        <Background className="flex-1 flex flex-col items-center justify-center px-6 py-10 relative">
                {/* Card */}
                <div className="w-full max-w-[380px] bg-white border border-gray-200 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] overflow-hidden">
                    {/* Card header */}
                    <div className="px-7 pt-7 pb-5 border-b border-gray-100">
                        {/* Mobile-only wordmark */}
                        <div className="flex items-center gap-2 mb-4 lg:hidden">
                            <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
                                <circle cx="14" cy="14" r="13" stroke="#6366f1" strokeWidth="1.5" />
                                <circle cx="14" cy="8"  r="2.5" fill="#6366f1" />
                                <circle cx="8"  cy="18" r="2.5" fill="#6366f1" />
                                <circle cx="20" cy="18" r="2.5" fill="#6366f1" />
                                <line x1="14" y1="10.5" x2="8.8"  y2="16"   stroke="#6366f1" strokeWidth="1.2" />
                                <line x1="14" y1="10.5" x2="19.2" y2="16"   stroke="#6366f1" strokeWidth="1.2" />
                                <line x1="9.5" y1="18"  x2="18.5" y2="18"   stroke="#6366f1" strokeWidth="1.2" />
                            </svg>
                            <span className="text-gray-900 font-bold text-[0.9rem]">Chain Analysis</span>
                        </div>

                        <p className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 mb-1">
                            Authentication
                        </p>
                        <h1 className="text-[1.5rem] font-bold tracking-tight text-gray-900 m-0">Welcome back</h1>
                        <p className="text-[0.82rem] text-gray-500 mt-1 mb-0">
                            Sign in to your investigator account
                        </p>
                    </div>

                    {/* Form */}
                    <form onSubmit={handleSubmit} className="px-7 py-6 flex flex-col gap-4">
                        {/* Email */}
                        <div className="flex flex-col gap-1.5">
                            <label
                                htmlFor="login-email"
                                className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400"
                            >
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
                            <label
                                htmlFor="login-password"
                                className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400"
                            >
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
                                    aria-label={showPassword ? "Hide password" : "Show password"}
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
                            type="submit"
                            disabled={loading}
                            className="inline-flex items-center justify-center gap-1.5 w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[0.85rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0 mt-1"
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

                    {/* Card footer */}
                    <div className="px-7 pb-6 flex items-center justify-center gap-1.5">
                        <span className="text-[0.8rem] text-gray-400">Don't have an account?</span>
                        <Link
                            to="/signup"
                            className="text-[0.8rem] font-semibold text-indigo-600 no-underline hover:underline"
                        >
                            Sign up
                        </Link>
                    </div>
                </div>

                {/* Mobile tagline */}
                <p className="lg:hidden text-[0.7rem] text-gray-400 mt-5">
                    Chain Analysis · AML Intelligence Platform
                </p>
            </Background>
        </div>
    );
}
