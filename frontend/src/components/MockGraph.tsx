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

export function MockGraph() {
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
