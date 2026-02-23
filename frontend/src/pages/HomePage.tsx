import { useNavigate } from "react-router-dom";
import { DotCube } from "../components/DotCube";
import { Background } from "../components/Background";
import { MockGraph } from "../components/MockGraph";

// ── Page ──────────────────────────────────────────────────────────────────────

export function HomePage() {
    const navigate = useNavigate();

    return (
        <Background>
            {/* Hero */}
            <div className="flex flex-1 items-center px-10 gap-0 max-w-[1280px] mx-auto w-full">
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
        </Background>
    );
}
