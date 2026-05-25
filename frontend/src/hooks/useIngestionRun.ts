import { useEffect } from "react";
import { useIngestionRuns } from "../context/IngestionRunsContext";
import type { IngestionRun } from "../types";

type Options = {
    onComplete?: (run: IngestionRun) => void;
};

/**
 * Subscribe to polling updates for a single ingestion run. Returns the latest
 * observed row, or `undefined` until the first poll resolves. When the run
 * reaches a terminal state, `onComplete` fires once and polling stops.
 */
export function useIngestionRun(runId: string | null | undefined, opts: Options = {}): IngestionRun | undefined {
    const { track, get } = useIngestionRuns();

    useEffect(() => {
        if (!runId) return;
        track(runId, { onComplete: opts.onComplete });
        // onComplete is captured once per runId; callers should pass a stable
        // handler (the context stores the latest per id).
    }, [runId, track, opts.onComplete]);

    return runId ? get(runId) : undefined;
}
