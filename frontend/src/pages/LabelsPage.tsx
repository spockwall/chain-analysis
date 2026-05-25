/**
 * Labels page — queue targeted-fetch jobs and submit annotations for pending tasks.
 *
 * Flow:
 *  1. Operators queue a fetch (addresses / hashes / neighborhood) → backend LPUSHes
 *     to the Redis INGEST_TARGETED_QUEUE and creates LabelTask rows.
 *  2. The Rust `worker` binary's task A BRPOPs the queue and runs the
 *     targeted fetch against Etherscan.
 *  3. Analysts open a pending task from the table and submit an AnnotationCreate,
 *     which flips the task status to `completed`.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
    enqueueLabelFetch,
    listLabelTasks,
    createAnnotation,
    formatAddress,
} from "../api/client";
import { useToastContext } from "../context/ToastContext";
import type {
    EntityType,
    LabelFetchRequest,
    LabelTaskResponse,
    LabelTaskStatus,
    RiskLevel,
} from "../types";
import {
    RISK_LEVELS,
    RISK_BADGE,
    ENTITY_TYPES,
    inputCls,
    selectCls,
    btnPrimary,
    btnGhost,
    btnSecondary,
    sectionLabel,
} from "../constants";

type FetchMode = "addresses" | "hashes" | "neighborhood";

const STATUS_FILTERS: Array<{ value: LabelTaskStatus | "all"; label: string }> = [
    { value: "pending", label: "Pending" },
    { value: "running", label: "running" },
    { value: "completed", label: "Completed" },
    { value: "cancelled", label: "Cancelled" },
    { value: "all", label: "All" },
];

const STATUS_BADGE: Record<LabelTaskStatus, string> = {
    pending: "border border-amber-500 text-amber-600",
    running: "border border-sky-500 text-sky-600",
    completed: "border border-green-500 text-green-600",
    cancelled: "border border-slate-400 text-slate-500",
};

export function LabelsPage() {
    const toast = useToastContext();
    const [params, setParams] = useSearchParams();
    const prefillAddress = params.get("address");

    // ── Queue-fetch form state ───────────────────────────────────────────────
    const [mode, setMode] = useState<FetchMode>("addresses");
    const [addressesInput, setAddressesInput] = useState(prefillAddress ?? "");
    const [hashesInput, setHashesInput] = useState("");
    const [seed, setSeed] = useState("");
    const [hops, setHops] = useState(1);
    const [queueing, setQueueing] = useState(false);

    // ── Task list state ──────────────────────────────────────────────────────
    const [statusFilter, setStatusFilter] = useState<LabelTaskStatus | "all">("pending");
    const [tasks, setTasks] = useState<LabelTaskResponse[]>([]);
    const [loadingTasks, setLoadingTasks] = useState(true);
    const [selectedTask, setSelectedTask] = useState<LabelTaskResponse | null>(null);

    // ── Annotation form state ────────────────────────────────────────────────
    const [annEntityType, setAnnEntityType] = useState<EntityType>("Unknown");
    const [annRisk, setAnnRisk] = useState<RiskLevel>("unknown");
    const [annLabelsInput, setAnnLabelsInput] = useState("");
    const [annNotes, setAnnNotes] = useState("");
    const [annEvidence, setAnnEvidence] = useState("");
    const [annConfidence, setAnnConfidence] = useState<number | "">("");
    const [submittingAnn, setSubmittingAnn] = useState(false);

    const loadTasks = useCallback(async () => {
        setLoadingTasks(true);
        try {
            const opts = statusFilter === "all" ? { limit: 100 } : { status: statusFilter, limit: 100 };
            const data = await listLabelTasks(opts);
            setTasks(data);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to load tasks");
        } finally {
            setLoadingTasks(false);
        }
    }, [statusFilter, toast]);

    useEffect(() => {
        loadTasks();
    }, [loadTasks]);

    // While any task is pending/in-progress, refresh every 5s so analysts see
    // the Rust worker drain + complete without a manual reload.
    useEffect(() => {
        const hasActive = tasks.some((t) => t.status === "pending" || t.status === "running");
        if (!hasActive) return;
        const handle = window.setInterval(loadTasks, 5000);
        return () => window.clearInterval(handle);
    }, [tasks, loadTasks]);

    // Clear the ?address= query param once consumed so navigation away doesn't leak it.
    useEffect(() => {
        if (prefillAddress) {
            setParams({}, { replace: true });
        }
    }, [prefillAddress, setParams]);

    function resetAnnotationForm() {
        setAnnEntityType("Unknown");
        setAnnRisk("unknown");
        setAnnLabelsInput("");
        setAnnNotes("");
        setAnnEvidence("");
        setAnnConfidence("");
    }

    function openTask(task: LabelTaskResponse) {
        setSelectedTask(task);
        resetAnnotationForm();
    }

    async function handleQueue(e: React.FormEvent) {
        e.preventDefault();
        const body: LabelFetchRequest = { mode };

        if (mode === "addresses") {
            const addrs = addressesInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            if (addrs.length === 0) {
                toast.error("Enter at least one address");
                return;
            }
            body.addresses = addrs;
        } else if (mode === "hashes") {
            const hashes = hashesInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            if (hashes.length === 0) {
                toast.error("Enter at least one transaction hash");
                return;
            }
            body.hashes = hashes;
        } else {
            if (!seed.trim()) {
                toast.error("Enter a seed address");
                return;
            }
            body.seed = seed.trim();
            body.hops = hops;
        }

        setQueueing(true);
        try {
            const res = await enqueueLabelFetch(body);
            toast.success(
                `Queued ${res.queued} task${res.queued === 1 ? "" : "s"} — worker will drain within seconds`,
            );
            setAddressesInput("");
            setHashesInput("");
            setSeed("");
            await loadTasks();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to queue fetch");
        } finally {
            setQueueing(false);
        }
    }

    async function handleSubmitAnnotation(e: React.FormEvent) {
        e.preventDefault();
        if (!selectedTask) return;

        const labels = annLabelsInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

        setSubmittingAnn(true);
        try {
            await createAnnotation({
                task_id: selectedTask.id,
                entity_address: selectedTask.entity_address,
                entity_type: annEntityType === "Unknown" ? null : annEntityType,
                risk_level: annRisk,
                labels,
                notes: annNotes.trim() || null,
                evidence: annEvidence.trim() || null,
                confidence: annConfidence === "" ? null : Number(annConfidence),
            });
            toast.success("Annotation submitted");
            setSelectedTask(null);
            resetAnnotationForm();
            await loadTasks();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to submit annotation");
        } finally {
            setSubmittingAnn(false);
        }
    }

    return (
        <div className="max-w-7xl mx-auto w-full px-6 py-6 flex flex-col gap-6">
            <header>
                <h1 className="text-xl font-bold text-gray-900">Labeling</h1>
                <p className="text-[0.8rem] text-gray-500 mt-1">
                    Queue addresses for targeted ingestion and submit analyst annotations.
                </p>
            </header>

            {/* ── Queue fetch form ───────────────────────────────────────── */}
            <section className="bg-white border border-gray-200 rounded-xl p-5">
                <h2 className="text-[0.9rem] font-semibold text-gray-900 mb-3">Queue targeted fetch</h2>
                <form onSubmit={handleQueue} className="flex flex-col gap-3">
                    <div className="flex gap-3 items-end flex-wrap">
                        <div className="flex flex-col gap-1">
                            <label className={sectionLabel}>Mode</label>
                            <select
                                className={selectCls}
                                value={mode}
                                onChange={(e) => setMode(e.target.value as FetchMode)}
                            >
                                <option value="addresses">Addresses</option>
                                <option value="hashes">Tx hashes</option>
                                <option value="neighborhood">Neighborhood</option>
                            </select>
                        </div>
                        {mode === "neighborhood" && (
                            <div className="flex flex-col gap-1">
                                <label className={sectionLabel}>Hops</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={3}
                                    value={hops}
                                    onChange={(e) => setHops(Number(e.target.value) || 1)}
                                    className={`${inputCls} w-20`}
                                />
                            </div>
                        )}
                    </div>

                    {mode === "addresses" && (
                        <div className="flex flex-col gap-1">
                            <label className={sectionLabel}>Addresses (comma or newline separated)</label>
                            <textarea
                                className={`${inputCls} font-mono min-h-[80px]`}
                                value={addressesInput}
                                onChange={(e) => setAddressesInput(e.target.value)}
                                placeholder="0xabc..., 0xdef..."
                            />
                        </div>
                    )}
                    {mode === "hashes" && (
                        <div className="flex flex-col gap-1">
                            <label className={sectionLabel}>Transaction hashes</label>
                            <textarea
                                className={`${inputCls} font-mono min-h-[80px]`}
                                value={hashesInput}
                                onChange={(e) => setHashesInput(e.target.value)}
                                placeholder="0xhash1, 0xhash2"
                            />
                        </div>
                    )}
                    {mode === "neighborhood" && (
                        <div className="flex flex-col gap-1">
                            <label className={sectionLabel}>Seed address</label>
                            <input
                                className={`${inputCls} font-mono`}
                                value={seed}
                                onChange={(e) => setSeed(e.target.value)}
                                placeholder="0x..."
                            />
                        </div>
                    )}

                    <div>
                        <button type="submit" disabled={queueing} className={btnPrimary}>
                            {queueing ? "Queueing…" : "Queue fetch"}
                        </button>
                    </div>
                </form>
            </section>

            {/* ── Tasks + annotation ─────────────────────────────────────── */}
            <section className="bg-white border border-gray-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                    <h2 className="text-[0.9rem] font-semibold text-gray-900">Tasks</h2>
                    <div className="flex items-center gap-2">
                        <select
                            className={selectCls}
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value as LabelTaskStatus | "all")}
                        >
                            {STATUS_FILTERS.map((f) => (
                                <option key={f.value} value={f.value}>
                                    {f.label}
                                </option>
                            ))}
                        </select>
                        <button type="button" onClick={loadTasks} className={btnGhost}>
                            Refresh
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] gap-5">
                    <div className="overflow-x-auto border border-gray-100 rounded-lg">
                        <table className="w-full text-[0.78rem]">
                            <thead className="bg-gray-50 text-gray-500">
                                <tr>
                                    <th className="px-3 py-2 text-left font-medium">Address</th>
                                    <th className="px-3 py-2 text-left font-medium">Status</th>
                                    <th className="px-3 py-2 text-left font-medium">Priority</th>
                                    <th className="px-3 py-2 text-left font-medium">Created</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {loadingTasks ? (
                                    <tr>
                                        <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                                            Loading…
                                        </td>
                                    </tr>
                                ) : tasks.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                                            No tasks.
                                        </td>
                                    </tr>
                                ) : (
                                    tasks.map((t) => {
                                        const active = selectedTask?.id === t.id;
                                        return (
                                            <tr
                                                key={t.id}
                                                className={`border-t border-gray-100 ${active ? "bg-gray-50" : ""}`}
                                            >
                                                <td className="px-3 py-2 font-mono text-gray-900">
                                                    {formatAddress(t.entity_address)}
                                                </td>
                                                <td className="px-3 py-2">
                                                    <span className={`px-1.5 py-[1px] rounded text-[0.68rem] ${STATUS_BADGE[t.status]}`}>
                                                        {t.status}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2 text-gray-600">{t.priority}</td>
                                                <td className="px-3 py-2 text-gray-500">
                                                    {new Date(t.created_at).toLocaleString()}
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    {t.status === "pending" || t.status === "running" ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => openTask(t)}
                                                            className={btnSecondary}
                                                        >
                                                            Annotate
                                                        </button>
                                                    ) : null}
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Annotation panel */}
                    <aside className="border border-gray-200 rounded-lg p-4 bg-gray-50/50 min-h-[280px]">
                        {!selectedTask ? (
                            <p className="text-[0.8rem] text-gray-400">
                                Select a pending task to submit an annotation.
                            </p>
                        ) : (
                            <form onSubmit={handleSubmitAnnotation} className="flex flex-col gap-3">
                                <div>
                                    <div className={sectionLabel}>Task #{selectedTask.id}</div>
                                    <div className="font-mono text-[0.78rem] text-gray-900 break-all">
                                        {selectedTask.entity_address}
                                    </div>
                                </div>

                                <div className="flex flex-col gap-1">
                                    <label className={sectionLabel}>Entity type</label>
                                    <select
                                        className={selectCls}
                                        value={annEntityType}
                                        onChange={(e) => setAnnEntityType(e.target.value as EntityType)}
                                    >
                                        {ENTITY_TYPES.map((t) => (
                                            <option key={t} value={t}>
                                                {t}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="flex flex-col gap-1">
                                    <label className={sectionLabel}>Risk level</label>
                                    <div className="flex gap-1 flex-wrap">
                                        {RISK_LEVELS.map((r) => (
                                            <button
                                                key={r}
                                                type="button"
                                                onClick={() => setAnnRisk(r)}
                                                className={`px-2 py-1 rounded text-[0.7rem] transition-all ${
                                                    annRisk === r
                                                        ? RISK_BADGE[r] + " font-semibold"
                                                        : "border border-gray-200 text-gray-500 hover:border-gray-400"
                                                }`}
                                            >
                                                {r}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="flex flex-col gap-1">
                                    <label className={sectionLabel}>Labels (comma separated)</label>
                                    <input
                                        className={inputCls}
                                        value={annLabelsInput}
                                        onChange={(e) => setAnnLabelsInput(e.target.value)}
                                        placeholder="mixer, suspicious"
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <label className={sectionLabel}>Notes</label>
                                    <textarea
                                        className={`${inputCls} min-h-[60px]`}
                                        value={annNotes}
                                        onChange={(e) => setAnnNotes(e.target.value)}
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <label className={sectionLabel}>Evidence (URL or reference)</label>
                                    <input
                                        className={inputCls}
                                        value={annEvidence}
                                        onChange={(e) => setAnnEvidence(e.target.value)}
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <label className={sectionLabel}>Confidence (0–1)</label>
                                    <input
                                        type="number"
                                        step="0.05"
                                        min={0}
                                        max={1}
                                        className={`${inputCls} w-28`}
                                        value={annConfidence}
                                        onChange={(e) =>
                                            setAnnConfidence(e.target.value === "" ? "" : Number(e.target.value))
                                        }
                                    />
                                </div>

                                <div className="flex gap-2 pt-1">
                                    <button type="submit" disabled={submittingAnn} className={btnPrimary}>
                                        {submittingAnn ? "Submitting…" : "Submit"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedTask(null)}
                                        className={btnGhost}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        )}
                    </aside>
                </div>
            </section>
        </div>
    );
}
