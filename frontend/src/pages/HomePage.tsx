import { useNavigate } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";

// ── Dot-cube background graphic ───────────────────────────────────────────────

function DotCube() {
    const dots = [];
    const cols = 22;
    const rows = 18;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const depth = (c / cols + r / rows) / 2;
            dots.push(
                <circle
                    key={`${r}-${c}`}
                    cx={c * 18}
                    cy={r * 18}
                    r={1.2}
                    fill="#b0b8c8"
                    opacity={0.25 + depth * 0.55}
                />,
            );
        }
    }
    return (
        <svg
            className="absolute -top-10 -left-20 w-[560px] h-[460px] opacity-90 pointer-events-none"
            viewBox={`0 0 ${22 * 18} ${18 * 18}`}
            preserveAspectRatio="xMidYMid meet"
        >
            {dots}
        </svg>
    );
}

// ── Mock graph card ───────────────────────────────────────────────────────────

function SvgPill({
    x,
    y,
    text,
    dark = false,
    dim = false,
}: {
    x: number;
    y: number;
    text: string;
    dark?: boolean;
    dim?: boolean;
}) {
    const pad = 8;
    const h = 22;
    const charW = 6.5;
    const w = text.length * charW + pad * 2;
    return (
        <g opacity={dim ? 0.4 : 1} transform={`translate(${x - w / 2}, ${y - h / 2})`}>
            <rect
                width={w}
                height={h}
                rx="5"
                fill={dark ? "#111827" : "white"}
                stroke={dark ? "none" : "#d1d5db"}
                strokeWidth="1.5"
            />
            <text
                x={w / 2}
                y={h / 2 + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="10"
                fontFamily="Outfit, Inter, sans-serif"
                fontWeight="500"
                fill={dark ? "white" : "#374151"}
            >
                {text}
            </text>
        </g>
    );
}

function MockGraph() {
    const origin = { x: 80, y: 160 };
    const mixer = { x: 250, y: 80 };
    const bridge = { x: 250, y: 240 };
    const destination = { x: 440, y: 120 };
    const dex = { x: 440, y: 240 };

    return (
        <div className="relative z-10 bg-white border border-gray-200 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] w-[600px] overflow-hidden">
            {/* header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
                <span className="w-2 h-2 rounded-full bg-gray-300" />
                <span className="text-[0.65rem] font-semibold tracking-widest text-gray-400 uppercase">
                    Transaction Flow Graph
                </span>
            </div>
            {/* svg */}
            <svg
                viewBox="0 0 560 320"
                className="block w-full"
                style={{ padding: "16px 24px", boxSizing: "border-box" }}
            >
                <path
                    d={`M ${origin.x} ${origin.y} C 130 ${origin.y} 160 ${bridge.y} ${bridge.x} ${bridge.y}`}
                    fill="none"
                    stroke="#d1d5db"
                    strokeWidth="1.5"
                />
                <path
                    d={`M ${bridge.x} ${bridge.y} C 260 ${bridge.y} 290 ${dex.y} ${dex.x} ${dex.y}`}
                    fill="none"
                    stroke="#d1d5db"
                    strokeWidth="1.5"
                    opacity="0.5"
                />
                <path
                    d={`M ${origin.x} ${origin.y} C 130 ${origin.y} 160 ${mixer.y} ${mixer.x} ${mixer.y}`}
                    fill="none"
                    stroke="#d1d5db"
                    strokeWidth="1.5"
                />
                <path
                    d={`M ${origin.x} ${origin.y} C 130 ${origin.y} 160 ${mixer.y} ${mixer.x} ${mixer.y} C 260 ${mixer.y} 290 ${destination.y} ${destination.x} ${destination.y}`}
                    fill="none"
                    stroke="#111827"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                />
                <path
                    d={`M ${mixer.x} ${mixer.y} C 260 ${mixer.y} 290 ${dex.y} ${dex.x} ${dex.y}`}
                    fill="none"
                    stroke="#d1d5db"
                    strokeWidth="1.5"
                    opacity="0.4"
                />

                <circle cx={origin.x} cy={origin.y} r="11" fill="#111827" />
                <circle cx={mixer.x} cy={mixer.y} r="7" fill="white" stroke="#d1d5db" strokeWidth="1.5" />
                <circle
                    cx={bridge.x}
                    cy={bridge.y}
                    r="7"
                    fill="white"
                    stroke="#d1d5db"
                    strokeWidth="1.5"
                    opacity="0.45"
                />
                <circle cx={destination.x} cy={destination.y} r="13" fill="#111827" />
                <circle cx={dex.x} cy={dex.y} r="7" fill="white" stroke="#d1d5db" strokeWidth="1.5" opacity="0.45" />

                <text
                    x={origin.x}
                    y={origin.y + 26}
                    textAnchor="middle"
                    fontSize="10"
                    fontFamily="Outfit, Inter, sans-serif"
                    fontWeight="500"
                    fill="#374151"
                >
                    Origin
                </text>
                <SvgPill x={mixer.x} y={mixer.y - 22} text="Mixer" />
                <SvgPill x={bridge.x} y={bridge.y + 22} text="Bridge" dim />
                <SvgPill x={destination.x} y={destination.y - 26} text="Risk: 98.4%" dark />
                <text
                    x={destination.x}
                    y={destination.y + 30}
                    textAnchor="middle"
                    fontSize="10"
                    fontFamily="Outfit, Inter, sans-serif"
                    fontWeight="500"
                    fill="#374151"
                >
                    Destination
                </text>
                <SvgPill x={dex.x} y={dex.y + 22} text="DEX" dim />
            </svg>
        </div>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function HomePage() {
    const navigate = useNavigate();

    return (
        <div
            className="min-h-screen flex flex-col font-[Outfit,Inter,sans-serif] text-gray-900 overflow-x-hidden"
            style={{
                backgroundColor: "#f5f5f5",
                backgroundImage:
                    "linear-gradient(#e2e2e2 1px, transparent 1px), linear-gradient(90deg, #e2e2e2 1px, transparent 1px)",
                backgroundSize: "48px 48px",
            }}
        >
            {/* Hero */}
            <div className="flex flex-1 items-center px-10 pt-20 pb-16 gap-0 max-w-[1280px] mx-auto w-full">
                {/* Left */}
                <div className="flex flex-col gap-6 w-[420px] shrink-0 z-10">
                    {/* Badge */}
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-full text-xs font-medium text-gray-600 w-fit shadow-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                        System v2.4 Available
                    </div>

                    <h1 className="text-[clamp(3rem,5vw,4.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em] m-0 text-gray-900">
                        Blockchain
                        <br />
                        <span className="text-gray-400">Traceability.</span>
                    </h1>

                    <p className="text-[0.95rem] leading-[1.65] text-gray-500 m-0 max-w-[360px]">
                        The AML intelligence layer for on-chain investigators. Map transaction flows, detect laundering
                        patterns, and make every finding defensible.
                    </p>

                    <div className="flex gap-3 items-center">
                        <button
                            onClick={() => navigate("/explorer")}
                            className="px-7 py-3 bg-gray-900 text-white text-[0.95rem] font-semibold rounded-lg cursor-pointer transition-all hover:bg-gray-800 hover:-translate-y-px"
                        >
                            Request Demo →
                        </button>
                        <button
                            onClick={() => navigate("/dashboard")}
                            className="px-7 py-3 bg-transparent text-gray-900 text-[0.95rem] font-medium rounded-lg cursor-pointer border border-gray-300 transition-all hover:border-gray-400 hover:bg-black/[0.03]"
                        >
                            Documentation
                        </button>
                    </div>
                </div>

                {/* Right */}
                <div className="flex-1 relative h-[520px] flex items-center justify-end">
                    <DotCube />
                    <MockGraph />
                </div>
            </div>
        </div>
    );
}
