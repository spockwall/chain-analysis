import { useState, useCallback, useRef } from "react";

export type ToastKind = "success" | "error" | "loading" | "info";

export interface Toast {
    id: string;
    kind: ToastKind;
    message: string;
}

export interface ToastApi {
    toasts: Toast[];
    success: (msg: string) => void;
    error: (msg: string) => void;
    loading: (msg: string) => string;   // returns id so caller can dismiss
    info: (msg: string) => void;
    dismiss: (id: string) => void;
    dismissAll: () => void;
}

const AUTO_DISMISS_MS = 4000;

export function useToast(): ToastApi {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

    const add = useCallback((kind: ToastKind, message: string, autoDismiss = true): string => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setToasts((prev) => [...prev, { id, kind, message }]);
        if (autoDismiss) {
            timers.current[id] = setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== id));
                delete timers.current[id];
            }, AUTO_DISMISS_MS);
        }
        return id;
    }, []);

    const dismiss = useCallback((id: string) => {
        clearTimeout(timers.current[id]);
        delete timers.current[id];
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const dismissAll = useCallback(() => {
        Object.values(timers.current).forEach(clearTimeout);
        timers.current = {};
        setToasts([]);
    }, []);

    return {
        toasts,
        success: (msg) => { add("success", msg); },
        error:   (msg) => { add("error", msg); },
        loading: (msg) => add("loading", msg, false),   // no auto-dismiss for loading
        info:    (msg) => { add("info", msg); },
        dismiss,
        dismissAll,
    };
}
