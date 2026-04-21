import { useEffect, useRef, useState } from "react";
import { useIngestionRuns } from "../context/IngestionRunsContext";
import type { IngestionRun, IngestionRunStatus } from "../types";

const STATUS_STYLES: Record<IngestionRunStatus, string> = {
    queued: "bg-amber-50 text-amber-700 border-amber-200",
    running: "bg-sky-50 text-sky-700 border-sky-200",
    completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    failed: "bg-rose-50 text-rose-700 border-rose-200",
};

const DOT_STYLES: Record<IngestionRunStatus, string> = {
    queued: "bg-amber-500",
    running: "bg-sky-500 animate-pulse",
    completed: "bg-emerald-500",
    failed: "bg-rose-500",
};

const ERROR_HELP: Record<string, string> = {
    rate_limited: "Etherscan rate limit hit — it will auto-retry shortly.",
    auth: "ETHERSCAN_API_KEY is missing or invalid — check the backend .env.",
    network: "Network error reaching Etherscan — check connectivity.",
    unknown: "Ingest failed — see backend logs for details.",
};

function errorTag(run: IngestionRun): string {
    const msg = run.error_message ?? "";
    const head = msg.split(":")[0]?.trim().toLowerCase() ?? "";
    return ERROR_HELP[head] ? head : "unknown";
}

export function RunStatusPill(): JSX.Element | null {
    const { runs } = useIngestionRuns();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const active = runs.filter((r) => r.status === "queued" || r.status === "running");
    const recent = [...runs].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? "")).slice(0, 10);

    useEffect(() => {
        function onOutside(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener("mousedown", onOutside);
        return () => document.removeEventListener("mousedown", onOutside);
    }, []);

    if (runs.length === 0) return null;

    // Pill summarizes the most interesting state: prefer active runs; otherwise
    // surface the newest terminal one so operators get feedback after a run
    // finishes.
    const head: IngestionRun = active[0] ?? recent[0];
    const status = head.status;
    const label = active.length > 0 ? `${status} · ${active.length}` : status;

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen((v) => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[0.72rem] font-medium transition-colors ${STATUS_STYLES[status]}`}
                title="Ingestion runs"
            >
                <span className={`w-1.5 h-1.5 rounded-full ${DOT_STYLES[status]}`} />
                <span className="uppercase tracking-wide">{label}</span>
            </button>

            {open && (
                <div
                    style={{ boxShadow: "0 4px 6px -1px rgba(0,0,0,0.07), 0 16px 32px -4px rgba(0,0,0,0.12)" }}
                    className="absolute right-0 bottom-[calc(100%+6px)] w-80 bg-white border border-gray-200/80 rounded-2xl overflow-hidden z-50"
                >
                    <div className="px-4 py-3 border-b border-gray-100">
                        <p className="text-[0.8rem] font-semibold text-gray-900">Ingestion runs</p>
                        <p className="text-[0.7rem] text-gray-500 mt-0.5">Last {recent.length} runs</p>
                    </div>
                    <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100">
                        {recent.map((run) => {
                            const tag = run.status === "failed" ? errorTag(run) : null;
                            return (
                                <li key={run.run_id} className="px-4 py-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <code className="text-[0.7rem] text-gray-600 font-mono truncate">{run.run_id}</code>
                                        <span
                                            className={`text-[0.65rem] font-semibold uppercase px-1.5 py-0.5 rounded border ${STATUS_STYLES[run.status]}`}
                                        >
                                            {run.status}
                                        </span>
                                    </div>
                                    <div className="text-[0.7rem] text-gray-500 mt-1 flex items-center gap-3">
                                        <span>{run.data_source}</span>
                                        {run.transactions_processed > 0 && (
                                            <span>{run.transactions_processed} txs</span>
                                        )}
                                    </div>
                                    {tag && (
                                        <p className="text-[0.7rem] text-rose-600 mt-1.5">{ERROR_HELP[tag]}</p>
                                    )}
                                </li>
                            );
                        })}
                        {recent.length === 0 && (
                            <li className="px-4 py-3 text-[0.75rem] text-gray-500">No runs yet.</li>
                        )}
                    </ul>
                </div>
            )}
        </div>
    );
}
