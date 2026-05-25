import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchIngestionRun, listIngestionRuns, listLabelTasks } from "../api/client";
import type { IngestionRun, IngestionRunStatus, LabelTaskResponse } from "../types";

const TERMINAL: IngestionRunStatus[] = ["completed", "failed"];
const POLL_MS = 2000;
const LABEL_POLL_MS = 2000;
const ACTIVE_KEY = "chain-analysis:active-runs";

type CompletionHandler = (run: IngestionRun) => void;
type TaskCompletionHandler = (task: LabelTaskResponse) => void;

interface TrackOptions {
    onComplete?: CompletionHandler;
}

interface TrackTaskOptions {
    onComplete?: TaskCompletionHandler;
}

interface IngestionRunsContextValue {
    runs: IngestionRun[];
    labelTasks: LabelTaskResponse[];
    track: (runId: string, opts?: TrackOptions) => void;
    trackTask: (taskId: number, opts?: TrackTaskOptions) => void;
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
    const taskHandlersRef = useRef<Record<number, TaskCompletionHandler | undefined>>({});
    const activeTasksRef = useRef<Set<number>>(new Set());
    const labelTasksRef = useRef<LabelTaskResponse[]>([]);

    const track = useCallback((runId: string, opts?: TrackOptions) => {
        if (!runId) return;
        handlersRef.current[runId] = opts?.onComplete;
        activeRef.current.add(runId);
        persistActive(activeRef.current);
    }, []);

    const trackTask = useCallback((taskId: number, opts?: TrackTaskOptions) => {
        if (!taskId) return;
        taskHandlersRef.current[taskId] = opts?.onComplete;
        activeTasksRef.current.add(taskId);
    }, []);

    const get = useCallback((runId: string) => runs[runId], [runs]);

    // Seed recent run history from the backend on mount so a refresh still
    // shows the run pill / drawer instead of starting empty.
    useEffect(() => {
        let cancelled = false;
        listIngestionRuns(10)
            .then((history) => {
                if (cancelled) return;
                setRuns((prev) => {
                    const next = { ...prev };
                    for (const run of history) next[run.run_id] = run;
                    return next;
                });
                // Resume polling for any historically-active runs that never
                // reached a terminal state (e.g. the tab was closed mid-run).
                for (const run of history) {
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
    // fetches from Labels + NodePanel and drained by the Rust worker — no
    // run_id to track individually, so just list pending + running.
    useEffect(() => {
        let cancelled = false;

        async function pollTasks() {
            try {
                // Use allSettled so a single failing status filter (e.g. a
                // stale browser tab with an outdated enum value) doesn't
                // preserve stale task state on the next merge.
                const [pendingRes, runningRes] = await Promise.allSettled([
                    listLabelTasks({ status: "pending", limit: 25 }),
                    listLabelTasks({ status: "running", limit: 25 }),
                ]);
                if (cancelled) return;
                const pending = pendingRes.status === "fulfilled" ? pendingRes.value : [];
                const inProgress = runningRes.status === "fulfilled" ? runningRes.value : [];
                const merged = [...pending, ...inProgress].sort(
                    (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""),
                );
                // Snapshot the previous task list BEFORE overwriting so we
                // can hand the last-known record to completion handlers
                // without an extra round-trip.
                const priorById = new Map(labelTasksRef.current.map((t) => [t.id, t]));
                labelTasksRef.current = merged;
                setLabelTasks(merged);

                // Fire completion handlers for tracked tasks that are no
                // longer in the active set (moved to completed / failed).
                // A task that dropped out of both pending and running has
                // reached a terminal state by definition — synthesize a
                // completed record from the last-known task rather than
                // spending an HTTP round-trip on /labels/tasks/{id}.
                const activeIds = new Set(merged.map((t) => t.id));
                for (const id of Array.from(activeTasksRef.current)) {
                    if (!activeIds.has(id)) {
                        const prior = priorById.get(id);
                        const handler = taskHandlersRef.current[id];
                        if (handler) {
                            const terminal: LabelTaskResponse = prior
                                ? { ...prior, status: "completed" }
                                : ({ id, status: "completed" } as LabelTaskResponse);
                            handler(terminal);
                        }
                        delete taskHandlersRef.current[id];
                        activeTasksRef.current.delete(id);
                    }
                }
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
        () => ({ runs: Object.values(runs), labelTasks, track, trackTask, get }),
        [runs, labelTasks, track, trackTask, get],
    );

    return <IngestionRunsContext.Provider value={value}>{children}</IngestionRunsContext.Provider>;
}

export function useIngestionRuns(): IngestionRunsContextValue {
    const ctx = useContext(IngestionRunsContext);
    if (!ctx) throw new Error("useIngestionRuns must be used inside <IngestionRunsProvider>");
    return ctx;
}
