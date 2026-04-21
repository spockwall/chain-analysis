import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchIngestionRun, listIngestionRuns, listLabelTasks } from "../api/client";
import type { IngestionRun, IngestionRunStatus, LabelTaskResponse } from "../types";

const TERMINAL: IngestionRunStatus[] = ["completed", "failed"];
const POLL_MS = 2000;
const LABEL_POLL_MS = 5000;
const ACTIVE_KEY = "chain-analysis:active-runs";

type CompletionHandler = (run: IngestionRun) => void;

interface TrackOptions {
    onComplete?: CompletionHandler;
}

interface IngestionRunsContextValue {
    runs: IngestionRun[];
    labelTasks: LabelTaskResponse[];
    track: (runId: string, opts?: TrackOptions) => void;
    get: (runId: string) => IngestionRun | undefined;
}

const IngestionRunsContext = createContext<IngestionRunsContextValue | undefined>(undefined);

function loadPersistedActive(): string[] {
    try {
        const raw = localStorage.getItem(ACTIVE_KEY);
        return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
        return [];
    }
}

function persistActive(ids: Set<string>) {
    try {
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(Array.from(ids)));
    } catch {
        // ignore
    }
}

export function IngestionRunsProvider({ children }: { children: ReactNode }): JSX.Element {
    const [runs, setRuns] = useState<Record<string, IngestionRun>>({});
    const [labelTasks, setLabelTasks] = useState<LabelTaskResponse[]>([]);
    const handlersRef = useRef<Record<string, CompletionHandler | undefined>>({});
    const activeRef = useRef<Set<string>>(new Set(loadPersistedActive()));

    const track = useCallback((runId: string, opts?: TrackOptions) => {
        if (!runId) return;
        handlersRef.current[runId] = opts?.onComplete;
        activeRef.current.add(runId);
        persistActive(activeRef.current);
    }, []);

    const get = useCallback((runId: string) => runs[runId], [runs]);

    // Seed recent run history from the backend on mount so a refresh still
    // shows the run pill / drawer instead of starting empty.
    useEffect(() => {
        let cancelled = false;
        listIngestionRuns(10)
            .then((history) => {
                if (cancelled) return;
                const userRuns = history.filter((r) => r.data_source !== "rust-process");
                setRuns((prev) => {
                    const next = { ...prev };
                    for (const run of userRuns) next[run.run_id] = run;
                    return next;
                });
                // Resume polling for any historically-active runs that never
                // reached a terminal state (e.g. the tab was closed mid-run).
                for (const run of userRuns) {
                    if (!TERMINAL.includes(run.status)) activeRef.current.add(run.run_id);
                }
                persistActive(activeRef.current);
            })
            .catch(() => {
                // non-fatal — first poll will still pick up tracked runs
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // One shared poll loop for all tracked runs.
    useEffect(() => {
        let cancelled = false;

        async function tick() {
            const ids = Array.from(activeRef.current);
            if (ids.length === 0) return;
            const results = await Promise.all(
                ids.map((id) =>
                    fetchIngestionRun(id)
                        .then((run) => ({ id, run }))
                        .catch(() => ({ id, run: null as IngestionRun | null })),
                ),
            );
            if (cancelled) return;
            setRuns((prev) => {
                const next = { ...prev };
                for (const { id, run } of results) {
                    if (run) {
                        // rust-process rows are consumer lifetime markers, not
                        // user ingests — evict from tracking so they don't sit
                        // "running" forever in the pill.
                        if (run.data_source === "rust-process") {
                            delete handlersRef.current[id];
                            delete next[id];
                            activeRef.current.delete(id);
                            continue;
                        }
                        next[id] = run;
                        if (TERMINAL.includes(run.status)) {
                            const handler = handlersRef.current[id];
                            handler?.(run);
                            delete handlersRef.current[id];
                            activeRef.current.delete(id);
                        }
                    }
                }
                persistActive(activeRef.current);
                return next;
            });
        }

        const handle = window.setInterval(tick, POLL_MS);
        tick();
        return () => {
            cancelled = true;
            window.clearInterval(handle);
        };
    }, []);

    // Poll label_tasks. These are created by deep-trace / hash-list / address
    // fetches from Labels + NodePanel and drained by the Dagster sensor — no
    // run_id to track individually, so just list pending + in_progress.
    useEffect(() => {
        let cancelled = false;

        async function pollTasks() {
            try {
                const [pending, inProgress] = await Promise.all([
                    listLabelTasks({ status: "pending", limit: 25 }),
                    listLabelTasks({ status: "in_progress", limit: 25 }),
                ]);
                if (cancelled) return;
                const merged = [...pending, ...inProgress].sort(
                    (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""),
                );
                setLabelTasks(merged);
            } catch {
                // non-fatal — keep last-known tasks
            }
        }

        const handle = window.setInterval(pollTasks, LABEL_POLL_MS);
        pollTasks();
        return () => {
            cancelled = true;
            window.clearInterval(handle);
        };
    }, []);

    const value = useMemo<IngestionRunsContextValue>(
        () => ({ runs: Object.values(runs), labelTasks, track, get }),
        [runs, labelTasks, track, get],
    );

    return <IngestionRunsContext.Provider value={value}>{children}</IngestionRunsContext.Provider>;
}

export function useIngestionRuns(): IngestionRunsContextValue {
    const ctx = useContext(IngestionRunsContext);
    if (!ctx) throw new Error("useIngestionRuns must be used inside <IngestionRunsProvider>");
    return ctx;
}
