export function DotCube({ className }: { className?: string }) {
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
            className={className || "absolute -top-10 -left-20 w-[560px] h-[460px] opacity-90 pointer-events-none"}
            viewBox={`0 0 ${22 * 18} ${18 * 18}`}
            preserveAspectRatio="xMidYMid meet"
        >
            {dots}
        </svg>
    );
}
