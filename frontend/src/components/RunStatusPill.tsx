import { useEffect, useRef, useState } from "react";
import { useIngestionRuns } from "../context/IngestionRunsContext";
import type { IngestionRun, LabelTaskResponse } from "../types";
import { formatAddress } from "../api/client";
import { Badge } from "./ui/Badge";
import { Pill } from "./ui/Pill";
import { RUN_STATUS_TONE, TASK_STATUS_TONE, type Tone } from "./ui/tokens";

type HeadState = "queued" | "running" | "completed" | "failed";

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

function pickHead(
    activeRuns: IngestionRun[],
    recentRun: IngestionRun | undefined,
    activeTasks: LabelTaskResponse[],
): HeadState {
    if (activeRuns.some((r) => r.status === "running")) return "running";
    if (activeTasks.some((t) => t.status === "running")) return "running";
    if (activeRuns.some((r) => r.status === "queued")) return "queued";
    if (activeTasks.some((t) => t.status === "pending")) return "queued";
    if (recentRun?.status === "failed") return "failed";
    return "completed";
}

export function RunStatusPill(): JSX.Element | null {
    const { runs, labelTasks } = useIngestionRuns();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const activeRuns = runs.filter((r) => r.status === "queued" || r.status === "running");
    const recentRuns = [...runs]
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
        .slice(0, 10);
    const activeTasks = labelTasks.filter(
        (t) => t.status === "pending" || t.status === "running",
    );
    const recentTasks = labelTasks.slice(0, 10);

    useEffect(() => {
        function onOutside(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener("mousedown", onOutside);
        return () => document.removeEventListener("mousedown", onOutside);
    }, []);

    if (runs.length === 0 && labelTasks.length === 0) return null;

    const activeTotal = activeRuns.length + activeTasks.length;
    const head = pickHead(activeRuns, recentRuns[0], activeTasks);
    const tone: Tone = RUN_STATUS_TONE[head];
    const label = activeTotal > 0 ? `${head} · ${activeTotal}` : head;

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen((v) => !v)}
                className="bg-transparent border-none p-0 cursor-pointer"
                title="Ingestion runs & label queue"
            >
                <Pill tone={tone} dot dotPulse={head === "running"}>
                    {label}
                </Pill>
            </button>

            {open && (
                <div
                    style={{ boxShadow: "0 4px 6px -1px rgba(0,0,0,0.07), 0 16px 32px -4px rgba(0,0,0,0.12)" }}
                    className="absolute right-0 bottom-[calc(100%+6px)] w-96 bg-white border border-gray-200/80 rounded-2xl overflow-hidden z-50"
                >
                    <div className="px-4 py-3 border-b border-gray-100">
                        <p className="text-[0.8rem] font-semibold text-gray-900">Background work</p>
                        <p className="text-[0.7rem] text-gray-500 mt-0.5">
                            {activeRuns.length} run(s), {activeTasks.length} queued task(s)
                        </p>
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                        <section>
                            <header className="px-4 py-2 border-b border-gray-100">
                                <p className="text-[0.65rem] font-semibold tracking-widest text-gray-500 uppercase">
                                    Ingestion runs
                                </p>
                            </header>
                            <ul className="divide-y divide-gray-100">
                                {recentRuns.map((run) => {
                                    const tag = run.status === "failed" ? errorTag(run) : null;
                                    return (
                                        <li key={run.run_id} className="px-4 py-2.5">
                                            <div className="flex items-center justify-between gap-2">
                                                <code className="text-[0.7rem] text-gray-600 font-mono truncate">
                                                    {run.run_id}
                                                </code>
                                                <Badge tone={RUN_STATUS_TONE[run.status]} size="sm">
                                                    {run.status}
                                                </Badge>
                                            </div>
                                            <div className="text-[0.7rem] text-gray-500 mt-1 flex items-center gap-3">
                                                <span>{run.data_source}</span>
                                                {run.transactions_processed > 0 && (
                                                    <span>{run.transactions_processed} txs</span>
                                                )}
                                            </div>
                                            {tag && (
                                                <p className="text-[0.7rem] text-red-600 mt-1.5">
                                                    {ERROR_HELP[tag]}
                                                </p>
                                            )}
                                        </li>
                                    );
                                })}
                                {recentRuns.length === 0 && (
                                    <li className="px-4 py-3 text-[0.75rem] text-gray-500">No runs yet.</li>
                                )}
                            </ul>
                        </section>

                        <section>
                            <header className="px-4 py-2 border-b border-t border-gray-100">
                                <p className="text-[0.65rem] font-semibold tracking-widest text-gray-500 uppercase">
                                    Label queue
                                </p>
                            </header>
                            <ul className="divide-y divide-gray-100">
                                {recentTasks.map((task) => (
                                    <li key={task.id} className="px-4 py-2.5">
                                        <div className="flex items-center justify-between gap-2">
                                            <code
                                                className="text-[0.7rem] text-gray-600 font-mono truncate"
                                                title={task.entity_address}
                                            >
                                                {formatAddress(task.entity_address)}
                                            </code>
                                            <Badge tone={TASK_STATUS_TONE[task.status]} size="sm">
                                                {task.status.replace("_", " ")}
                                            </Badge>
                                        </div>
                                        {task.title && (
                                            <p className="text-[0.7rem] text-gray-500 mt-1 truncate">
                                                {task.title}
                                            </p>
                                        )}
                                    </li>
                                ))}
                                {recentTasks.length === 0 && (
                                    <li className="px-4 py-3 text-[0.75rem] text-gray-500">
                                        No pending label tasks.
                                    </li>
                                )}
                            </ul>
                        </section>
                    </div>
                </div>
            )}
        </div>
    );
}
