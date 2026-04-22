/**
 * Toaster — fixed bottom-left stack of toast notifications.
 * Reads from ToastContext; render once at the App root.
 */
import { createPortal } from "react-dom";
import { useToastContext } from "../context/ToastContext";
import type { Toast, ToastKind } from "../hooks/useToast";

function SuccessIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function ErrorIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
    );
}

function InfoIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
    );
}

function Spinner() {
    return (
        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

const KIND_META: Record<ToastKind, { icon: React.ReactNode; cls: string; iconCls: string }> = {
    success: {
        icon: <SuccessIcon />,
        cls: "bg-[rgba(249,250,251,0.96)] border-[rgba(34,197,94,0.35)] text-gray-900",
        iconCls: "text-green-500",
    },
    error: {
        icon: <ErrorIcon />,
        cls: "bg-[rgba(249,250,251,0.96)] border-[rgba(239,68,68,0.35)] text-gray-900",
        iconCls: "text-red-500",
    },
    loading: {
        icon: <Spinner />,
        cls: "bg-gray-900 border-white/10 text-gray-100",
        iconCls: "text-gray-100 opacity-70",
    },
    info: {
        icon: <InfoIcon />,
        cls: "bg-[rgba(249,250,251,0.96)] border-[rgba(59,130,246,0.35)] text-gray-900",
        iconCls: "text-blue-500",
    },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
    const { icon, cls, iconCls } = KIND_META[toast.kind];
    return (
        <div className={`pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border text-[0.78rem] font-medium leading-[1.4] shadow-lg max-w-[340px] backdrop-blur-sm animate-[toast-slide-in_250ms_cubic-bezier(0.4,0,0.2,1)] ${cls}`}>
            <span className={`shrink-0 flex items-center ${iconCls}`}>{icon}</span>
            <span className="flex-1 min-w-0 break-words">{toast.message}</span>
            <button
                className={`shrink-0 flex items-center justify-center w-5 h-5 border-none bg-transparent cursor-pointer rounded p-0 transition-colors ${toast.kind === "loading" ? "text-white/40 hover:text-white/80" : "text-gray-400 hover:text-gray-900 hover:bg-gray-100"}`}
                onClick={onDismiss}
                aria-label="Dismiss"
            >
                <CloseIcon />
            </button>
        </div>
    );
}

export function Toaster() {
    const { toasts, dismiss } = useToastContext();
    if (toasts.length === 0) return null;
    return createPortal(
        <div className="fixed bottom-6 left-6 z-[9999] flex flex-col gap-2 pointer-events-none">
            {toasts.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
        </div>,
        document.body,
    );
}
