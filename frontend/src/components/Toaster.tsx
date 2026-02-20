/**
 * Toaster — fixed bottom-right stack of toast notifications.
 * Reads from ToastContext; render once at the App root.
 */
import { createPortal } from "react-dom";
import { useToastContext } from "../context/ToastContext";
import type { Toast, ToastKind } from "../hooks/useToast";

// ── Icons ─────────────────────────────────────────────────────────────────────

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
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

function InfoIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
    );
}

function Spinner() {
    return (
        <svg className="toast-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

// ── Per-kind appearance ───────────────────────────────────────────────────────

const KIND_META: Record<ToastKind, { icon: React.ReactNode; cls: string }> = {
    success: { icon: <SuccessIcon />, cls: "toast-item toast-item--success" },
    error:   { icon: <ErrorIcon />,   cls: "toast-item toast-item--error"   },
    loading: { icon: <Spinner />,     cls: "toast-item toast-item--loading" },
    info:    { icon: <InfoIcon />,    cls: "toast-item toast-item--info"    },
};

// ── Single toast ──────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
    const { icon, cls } = KIND_META[toast.kind];
    return (
        <div className={cls}>
            <span className="toast-item__icon">{icon}</span>
            <span className="toast-item__msg">{toast.message}</span>
            <button className="toast-item__close" onClick={onDismiss} aria-label="Dismiss">
                <CloseIcon />
            </button>
        </div>
    );
}

// ── Toaster root ──────────────────────────────────────────────────────────────

export function Toaster() {
    const { toasts, dismiss } = useToastContext();

    if (toasts.length === 0) return null;

    return createPortal(
        <div className="toaster">
            {toasts.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
        </div>,
        document.body,
    );
}
