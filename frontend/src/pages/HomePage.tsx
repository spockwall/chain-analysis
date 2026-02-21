import { useNavigate } from "react-router-dom";

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
        <svg className="lp-dot-cube" viewBox={`0 0 ${22 * 18} ${18 * 18}`} preserveAspectRatio="xMidYMid meet">
            {dots}
        </svg>
    );
}

// ── Mock graph card ───────────────────────────────────────────────────────────

// Pill label rendered fully inside SVG — no absolute HTML overlays
function SvgPill({ x, y, text, dark = false, dim = false }: {
    x: number; y: number; text: string; dark?: boolean; dim?: boolean;
}) {
    const pad = 8;
    const h = 22;
    const charW = 6.5;
    const w = text.length * charW + pad * 2;
    return (
        <g opacity={dim ? 0.4 : 1} transform={`translate(${x - w / 2}, ${y - h / 2})`}>
            <rect
                width={w} height={h} rx="5"
                fill={dark ? "#111827" : "white"}
                stroke={dark ? "none" : "#d1d5db"}
                strokeWidth="1.5"
            />
            <text
                x={w / 2} y={h / 2 + 1}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="10" fontFamily="Outfit, Inter, sans-serif"
                fontWeight="500"
                fill={dark ? "white" : "#374151"}
            >
                {text}
            </text>
        </g>
    );
}

function MockGraph() {
    // Node positions — spread across 560×320 viewBox
    const origin      = { x: 80,  y: 160 };
    const mixer       = { x: 250, y: 80  };
    const bridge      = { x: 250, y: 240 };
    const destination = { x: 440, y: 120 };
    const dex         = { x: 440, y: 240 };

    return (
        <div className="lp-graph-card">
            <div className="lp-graph-header">
                <span className="lp-graph-header-dot" />
                <span className="lp-graph-header-title">TRANSACTION FLOW GRAPH</span>
            </div>
            <svg viewBox="0 0 560 320" className="lp-graph-svg" style={{ display: "block", padding: "16px 24px", boxSizing: "border-box" }}>
                {/* dim edges */}
                <path d={`M ${origin.x} ${origin.y} C 130 ${origin.y} 160 ${bridge.y} ${bridge.x} ${bridge.y}`}
                    fill="none" stroke="#d1d5db" strokeWidth="1.5" />
                <path d={`M ${bridge.x} ${bridge.y} C 260 ${bridge.y} 290 ${dex.y} ${dex.x} ${dex.y}`}
                    fill="none" stroke="#d1d5db" strokeWidth="1.5" opacity="0.5" />

                {/* active path */}
                <path d={`M ${origin.x} ${origin.y} C 130 ${origin.y} 160 ${mixer.y} ${mixer.x} ${mixer.y}`}
                    fill="none" stroke="#d1d5db" strokeWidth="1.5" />
                <path d={`M ${origin.x} ${origin.y} C 130 ${origin.y} 160 ${mixer.y} ${mixer.x} ${mixer.y} C 260 ${mixer.y} 290 ${destination.y} ${destination.x} ${destination.y}`}
                    fill="none" stroke="#111827" strokeWidth="2.5" strokeLinecap="round" />

                {/* dim edge to dex */}
                <path d={`M ${mixer.x} ${mixer.y} C 260 ${mixer.y} 290 ${dex.y} ${dex.x} ${dex.y}`}
                    fill="none" stroke="#d1d5db" strokeWidth="1.5" opacity="0.4" />

                {/* nodes */}
                <circle cx={origin.x}      cy={origin.y}      r="11" fill="#111827" />
                <circle cx={mixer.x}       cy={mixer.y}       r="7"  fill="white" stroke="#d1d5db" strokeWidth="1.5" />
                <circle cx={bridge.x}      cy={bridge.y}      r="7"  fill="white" stroke="#d1d5db" strokeWidth="1.5" opacity="0.45" />
                <circle cx={destination.x} cy={destination.y} r="13" fill="#111827" />
                <circle cx={dex.x}         cy={dex.y}         r="7"  fill="white" stroke="#d1d5db" strokeWidth="1.5" opacity="0.45" />

                {/* labels — all in SVG, no overlap */}
                <text x={origin.x} y={origin.y + 26}
                    textAnchor="middle" fontSize="10" fontFamily="Outfit, Inter, sans-serif"
                    fontWeight="500" fill="#374151">
                    Origin
                </text>

                <SvgPill x={mixer.x}       y={mixer.y - 22}       text="Mixer" />
                <SvgPill x={bridge.x}      y={bridge.y + 22}      text="Bridge"      dim />
                <SvgPill x={destination.x} y={destination.y - 26} text="Risk: 98.4%" dark />
                <text x={destination.x} y={destination.y + 30}
                    textAnchor="middle" fontSize="10" fontFamily="Outfit, Inter, sans-serif"
                    fontWeight="500" fill="#374151">
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
        <div className="lp-page">
            {/* Hero */}
            <div className="lp-hero">
                <div className="lp-hero-left">
                    <h1 className="lp-heading">
                        Blockchain
                        <br />
                        <span className="lp-heading-muted">Traceability.</span>
                    </h1>

                    <p className="lp-subtext">
                        The AML intelligence layer for on-chain investigators. Map transaction flows, detect laundering
                        patterns, and make every finding defensible.
                    </p>

                    <div className="lp-cta-row">
                        <button className="lp-btn-dark lp-btn-lg" onClick={() => navigate("/")}>
                            Request Demo →
                        </button>
                        <button className="lp-btn-outline lp-btn-lg" onClick={() => navigate("/")}>
                            Documentation
                        </button>
                    </div>
                </div>

                <div className="lp-hero-right">
                    <DotCube />
                    <MockGraph />
                </div>
            </div>
        </div>
    );
}
