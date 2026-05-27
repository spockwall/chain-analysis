import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    addCriminalAddress,
    addCriminalTransaction,
    deleteCriminalDatasetEntry,
    fetchCriminalDataset,
    formatAddress,
} from "../api/client";
import { useToastContext } from "../context/ToastContext";
import type { CriminalDatasetEntry, CriminalDatasetEntryType } from "../types";
import { btnDangerSm, btnGhost, btnPrimary, inputCls, sectionLabel } from "../constants";

type AddMode = "address" | "transaction";
type FilterMode = "all" | CriminalDatasetEntryType;

const FILTERS: Array<{ value: FilterMode; label: string }> = [
    { value: "all", label: "All" },
    { value: "address", label: "Addresses" },
    { value: "transaction", label: "Transactions" },
];

function typeBadge(entryType: CriminalDatasetEntryType) {
    if (entryType === "address") {
        return "border border-red-500 text-red-600";
    }
    return "border border-gray-900 text-gray-900";
}

function formatDate(value: string) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

export function CriminalDatasetPage() {
    const toast = useToastContext();
    const navigate = useNavigate();
    const [entries, setEntries] = useState<CriminalDatasetEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [mode, setMode] = useState<AddMode>("address");
    const [filter, setFilter] = useState<FilterMode>("all");
    const [identifier, setIdentifier] = useState("");
    const [note, setNote] = useState("");

    const loadDataset = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            const data = await fetchCriminalDataset(1000);
            setEntries(data.entries);
            setTotal(data.total);
        } catch (err: unknown) {
            if (!quiet) {
                toast.error(err instanceof Error ? err.message : "Failed to load dataset");
            }
        } finally {
            if (!quiet) setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        loadDataset();
    }, [loadDataset]);

    useEffect(() => {
        const handle = window.setInterval(() => loadDataset(true), 3000);
        return () => window.clearInterval(handle);
    }, [loadDataset]);

    const visibleEntries = useMemo(() => {
        if (filter === "all") return entries;
        return entries.filter((entry) => entry.entry_type === filter);
    }, [entries, filter]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const value = identifier.trim();
        if (!value) {
            toast.error(mode === "address" ? "Address is required" : "Transaction hash is required");
            return;
        }

        setSubmitting(true);
        try {
            const bodyNote = note.trim() || null;
            const result = mode === "address"
                ? await addCriminalAddress({ criminal_address: value, note: bodyNote })
                : await addCriminalTransaction({ criminal_transaction_hash: value, note: bodyNote });

            const message = result.created > 0
                ? `Added ${result.created} entr${result.created === 1 ? "y" : "ies"}`
                : "Entry already exists";
            toast.success(message);
            setIdentifier("");
            setNote("");
            await loadDataset(true);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to add entry");
        } finally {
            setSubmitting(false);
        }
    }

    async function handleDelete(entry: CriminalDatasetEntry) {
        setDeletingId(entry.id);
        try {
            await deleteCriminalDatasetEntry(entry.id);
            toast.success("Entry deleted");
            setEntries((prev) => prev.filter((item) => item.id !== entry.id));
            setTotal((prev) => Math.max(0, prev - 1));
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to delete entry");
        } finally {
            setDeletingId(null);
        }
    }

    function openEntry(entry: CriminalDatasetEntry) {
        if (entry.criminal_address) {
            navigate(`/explorer?address=${encodeURIComponent(entry.criminal_address)}`);
        } else if (entry.criminal_transaction_hash) {
            navigate(`/explorer?tx=${encodeURIComponent(entry.criminal_transaction_hash)}`);
        }
    }

    return (
        <div className="max-w-7xl mx-auto w-full px-6 py-6 flex flex-col gap-5">
            <header className="flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-xl font-bold text-gray-900">Criminal Dataset</h1>
                    <p className="text-[0.78rem] text-gray-500 mt-1">
                        {total} shared entr{total === 1 ? "y" : "ies"}
                    </p>
                </div>
                <div className="flex items-center gap-1.5">
                    {FILTERS.map((item) => (
                        <button
                            key={item.value}
                            onClick={() => setFilter(item.value)}
                            className={`px-3 py-1.5 rounded-lg text-[0.75rem] font-semibold border transition-colors ${
                                filter === item.value
                                    ? "bg-gray-900 text-white border-gray-900"
                                    : "bg-white text-gray-500 border-gray-200 hover:text-gray-900"
                            }`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </header>

            <section className="bg-white border border-gray-200 rounded-xl p-5">
                <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-[160px_1fr_1fr_auto] gap-3 items-end">
                    <div className="flex flex-col gap-1.5">
                        <label className={sectionLabel}>Type</label>
                        <div className="grid grid-cols-2 rounded-lg border border-gray-200 overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setMode("address")}
                                className={`px-3 py-2 text-[0.75rem] font-semibold ${
                                    mode === "address" ? "bg-gray-900 text-white" : "bg-white text-gray-500"
                                }`}
                            >
                                Address
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode("transaction")}
                                className={`px-3 py-2 text-[0.75rem] font-semibold border-l border-gray-200 ${
                                    mode === "transaction" ? "bg-gray-900 text-white" : "bg-white text-gray-500"
                                }`}
                            >
                                Tx
                            </button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className={sectionLabel}>
                            {mode === "address" ? "Criminal address" : "Criminal transaction"}
                        </label>
                        <input
                            className={`${inputCls} font-mono`}
                            value={identifier}
                            onChange={(e) => setIdentifier(e.target.value)}
                            placeholder={mode === "address" ? "0x..." : "0x transaction hash"}
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className={sectionLabel}>Note</label>
                        <input
                            className={inputCls}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Optional"
                        />
                    </div>

                    <button className={btnPrimary} disabled={submitting}>
                        {submitting ? "Adding..." : "Add"}
                    </button>
                </form>
            </section>

            <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[920px] text-left border-collapse">
                        <thead className="bg-gray-50 border-b border-gray-200">
                            <tr>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400">Type</th>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400">Identifier</th>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400">Source</th>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400">Note</th>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400">Added by</th>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400">Added</th>
                                <th className="px-4 py-3 text-[0.65rem] font-bold uppercase tracking-wider text-gray-400 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-10 text-center text-[0.8rem] text-gray-400">
                                        Loading...
                                    </td>
                                </tr>
                            ) : visibleEntries.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-10 text-center text-[0.8rem] text-gray-400">
                                        No entries
                                    </td>
                                </tr>
                            ) : (
                                visibleEntries.map((entry) => {
                                    const identifierValue = entry.criminal_address ?? entry.criminal_transaction_hash ?? "";
                                    return (
                                        <tr key={entry.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/70">
                                            <td className="px-4 py-3 align-top">
                                                <span className={`inline-flex px-2 py-1 rounded-md text-[0.68rem] font-semibold ${typeBadge(entry.entry_type)}`}>
                                                    {entry.entry_type === "address" ? "Address" : "Transaction"}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 align-top">
                                                <button
                                                    onClick={() => openEntry(entry)}
                                                    className="font-mono text-[0.78rem] text-gray-900 hover:underline"
                                                    title={identifierValue}
                                                >
                                                    {entry.entry_type === "address"
                                                        ? formatAddress(identifierValue, 8)
                                                        : formatAddress(identifierValue, 10)}
                                                </button>
                                            </td>
                                            <td className="px-4 py-3 align-top">
                                                {entry.source_transaction_hash ? (
                                                    <button
                                                        onClick={() => navigate(`/explorer?tx=${encodeURIComponent(entry.source_transaction_hash ?? "")}`)}
                                                        className="font-mono text-[0.72rem] text-gray-500 hover:text-gray-900 hover:underline"
                                                        title={entry.source_transaction_hash}
                                                    >
                                                        {formatAddress(entry.source_transaction_hash, 8)}
                                                    </button>
                                                ) : (
                                                    <span className="text-[0.75rem] text-gray-300">Manual</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 align-top max-w-[260px]">
                                                <p className="text-[0.78rem] text-gray-600 truncate">
                                                    {entry.note || "-"}
                                                </p>
                                            </td>
                                            <td className="px-4 py-3 align-top">
                                                <span className="text-[0.78rem] text-gray-600">
                                                    {entry.created_by_username ?? "Unknown"}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 align-top">
                                                <span className="text-[0.75rem] text-gray-500">
                                                    {formatDate(entry.created_at)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 align-top">
                                                <div className="flex items-center justify-end gap-2">
                                                    <button className={btnGhost} onClick={() => openEntry(entry)}>
                                                        Open
                                                    </button>
                                                    <button
                                                        className={btnDangerSm}
                                                        disabled={!entry.can_delete || deletingId === entry.id}
                                                        onClick={() => handleDelete(entry)}
                                                        title={entry.can_delete ? "Delete" : "Only creator or admin can delete"}
                                                    >
                                                        {deletingId === entry.id ? "Deleting..." : "Delete"}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
