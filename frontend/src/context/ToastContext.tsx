import { createContext, useContext } from "react";
import type { ToastApi } from "../hooks/useToast";

export const ToastContext = createContext<ToastApi | null>(null);

export function useToastContext(): ToastApi {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToastContext must be used inside <ToastProvider>");
    return ctx;
}
