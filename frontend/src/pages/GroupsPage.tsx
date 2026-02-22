/**
 * Groups management page — list, create, update, delete group entities.
 */
import React, { useEffect, useState } from "react";
import {
    fetchGroups,
    fetchGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    addGroupMember,
    removeGroupMember,
    formatAddress,
} from "../api/client";
import { useToastContext } from "../context/ToastContext";
import type { EntityResponse, GroupDetailResponse, RiskLevel } from "../types";
import {
    RISK_LEVELS,
    RISK_COLOR,
    RISK_BADGE,
    ENTITY_TYPES,
    inputCls,
    btnPrimary,
    btnPrimarySm,
    btnGhost,
    btnDangerSm,
} from "../constants";

interface GroupsPageProps {
    onNavigateToExplorer: (address: string) => void;
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400">{label}</label>
            {children}
        </div>
    );
}

export function GroupsPage({ onNavigateToExplorer }: GroupsPageProps) {
    const toast = useToastContext();

    const [groups, setGroups] = useState<GroupDetailResponse[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<GroupDetailResponse | null>(null);
    const [showCreateForm, setShowCreateForm] = useState(false);

    const [editName, setEditName] = useState("");
    const [editRisk, setEditRisk] = useState<RiskLevel>("unknown");
    const [editDesc, setEditDesc] = useState("");
    const [saving, setSaving] = useState(false);

    const [newName, setNewName] = useState("");
    const [newDesc, setNewDesc] = useState("");
    const [newType, setNewType] = useState<string>("Contract");
    const [creating, setCreating] = useState(false);

    const [memberInput, setMemberInput] = useState("");
    const [pendingMembers, setPendingMembers] = useState<string[]>([]);
    const [removedMembers, setRemovedMembers] = useState<string[]>([]);
    const [selectedMember, setSelectedMember] = useState<EntityResponse | null>(null);

    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [editMode, setEditMode] = useState(false);

    async function loadGroups() {
        setLoading(true);
        try {
            const data = await fetchGroups();
            setGroups(data.groups);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to load groups");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadGroups();
    }, []);

    function selectGroup(group: GroupDetailResponse) {
        setSelected(group);
        setShowCreateForm(false);
        setEditName(group.name ?? "");
        setEditRisk(group.risk_level);
        setEditDesc((group.properties?.description as string) ?? "");
        setMemberInput("");
        setPendingMembers([]);
        setRemovedMembers([]);
        setSelectedMember(null);
        setEditMode(false);
    }

    async function handleSelectAddress(address: string) {
        try {
            const detail = await fetchGroup(address);
            selectGroup(detail);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to load group");
        }
    }

    async function handleCreate() {
        if (!newName.trim()) {
            toast.error("Name is required");
            return;
        }
        setCreating(true);
        try {
            const created = await createGroup({
                name: newName.trim(),
                entity_type: newType,
                description: newDesc.trim() || undefined,
            });
            toast.success(`Group "${created.name}" created`);
            await loadGroups();
            setShowCreateForm(false);
            setNewName("");
            setNewDesc("");
            setNewType("Contract");
            setSelected(created);
            setEditName(created.name ?? "");
            setEditRisk(created.risk_level);
            setEditDesc(created.description ?? "");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to create group");
        } finally {
            setCreating(false);
        }
    }

    async function handleSave() {
        if (!selected) return;
        setSaving(true);
        try {
            await updateGroup(selected.address, {
                name: editName || undefined,
                risk_level: editRisk,
                description: editDesc || undefined,
            });
            await Promise.all([
                ...pendingMembers.map((addr) => addGroupMember(selected.address, addr)),
                ...removedMembers.map((addr) => removeGroupMember(selected.address, addr)),
            ]);
            const refreshed = await fetchGroup(selected.address);
            toast.success("Group saved");
            setSelected(refreshed);
            setGroups((prev) => prev.map((g) => (g.address === refreshed.address ? refreshed : g)));
            setPendingMembers([]);
            setRemovedMembers([]);
            setEditMode(false);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to save group");
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete() {
        if (!selected) return;
        if (selected.member_count > 0) return;
        try {
            await deleteGroup(selected.address);
            toast.success("Group deleted");
            setGroups((prev) => prev.filter((g) => g.address !== selected.address));
            setSelected(null);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to delete group");
        }
    }

    function handleStageMember() {
        const addr = memberInput.trim().toLowerCase();
        if (!addr) return;
        if (pendingMembers.includes(addr)) {
            setMemberInput("");
            return;
        }
        if (selected?.members.some((m) => m.address === addr && !removedMembers.includes(addr))) {
            toast.error("Address is already a member");
            return;
        }
        setPendingMembers((prev) => [...prev, addr]);
        setMemberInput("");
    }

    function handleUnstageMember(addr: string) {
        setPendingMembers((prev) => prev.filter((a) => a !== addr));
    }

    function handleMarkRemove(addr: string) {
        setRemovedMembers((prev) => [...prev, addr]);
        if (selectedMember?.address === addr) setSelectedMember(null);
    }

    function handleUnmarkRemove(addr: string) {
        setRemovedMembers((prev) => prev.filter((a) => a !== addr));
    }

    return (
        <div className="flex h-full overflow-hidden bg-[#f9fafb]">
            {/* ── Left: group list ── */}
            <div
                className={`shrink-0 border-r border-gray-200 flex flex-col overflow-hidden bg-white transition-all duration-200 ${sidebarOpen ? "w-[240px]" : "w-10"}`}
            >
                {sidebarOpen ? (
                    <>
                        {/* Header */}
                        <div className="px-4 pt-5 pb-3 border-b border-gray-100 shrink-0">
                            <div className="flex items-center justify-between gap-2 mb-3">
                                <button
                                    onClick={() => setSidebarOpen(false)}
                                    className="text-[0.72rem] font-bold tracking-wider uppercase text-gray-400"
                                >
                                    {"<"} Groups
                                </button>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        className={btnPrimarySm}
                                        onClick={() => {
                                            setShowCreateForm(true);
                                            setSelected(null);
                                        }}
                                    >
                                        + New
                                    </button>
                                </div>
                            </div>
                            <p className="text-[0.68rem] text-gray-400 m-0">
                                {loading ? "Loading…" : `${groups.length} group${groups.length !== 1 ? "s" : ""}`}
                            </p>
                        </div>

                        {/* List */}
                        <div className="flex-1 overflow-y-auto py-1">
                            {groups.map((g) => {
                                const isActive = selected?.address === g.address && !showCreateForm;
                                return (
                                    <button
                                        key={g.address}
                                        className={`w-full text-left px-4 py-2.5 border-none cursor-pointer transition-colors flex flex-col gap-0.5 ${
                                            isActive
                                                ? "bg-gray-900 text-white"
                                                : "bg-transparent text-gray-900 hover:bg-gray-50"
                                        }`}
                                        onClick={() => handleSelectAddress(g.address)}
                                    >
                                        <div
                                            className={`text-[0.8rem] font-semibold truncate ${isActive ? "text-white" : "text-gray-900"}`}
                                        >
                                            {g.name ?? formatAddress(g.address)}
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span
                                                className={`text-[0.65rem] font-medium ${isActive ? "text-gray-300" : "text-gray-500"}`}
                                            >
                                                {g.member_count} member{g.member_count !== 1 ? "s" : ""}
                                            </span>
                                            <span
                                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                                style={{ background: RISK_COLOR[g.risk_level] }}
                                                title={g.risk_level}
                                            />
                                        </div>
                                    </button>
                                );
                            })}
                            {!loading && groups.length === 0 && (
                                <p className="text-[0.78rem] text-gray-400 text-center px-4 py-8 m-0">No groups yet.</p>
                            )}
                        </div>
                    </>
                ) : (
                    /* Collapsed: just a toggle button */
                    <button
                        className="flex-1 flex items-start justify-center pt-5 border-none bg-transparent cursor-pointer text-gray-400 hover:text-gray-700 transition-colors"
                        onClick={() => setSidebarOpen(true)}
                        title="Expand sidebar"
                    >
                        {">"}
                    </button>
                )}
            </div>

            {/* ── Right: detail / create panel ── */}
            <div className="flex-1 overflow-y-auto">
                {/* Create form */}
                {showCreateForm && (
                    <div className="max-w-[860px] mx-auto px-6 py-8 flex flex-col gap-5">
                        <div>
                            <p className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 mb-1">
                                Groups
                            </p>
                            <h2 className="text-xl font-bold text-gray-900 m-0">New Group</h2>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)] flex flex-col gap-4">
                            <div className="grid grid-cols-2 gap-4">
                                <FormField label="Name">
                                    <input
                                        className={inputCls}
                                        placeholder="e.g. Tornado Cash Protocol"
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                                    />
                                </FormField>
                                <FormField label="Type">
                                    <select
                                        className={inputCls}
                                        value={newType}
                                        onChange={(e) => setNewType(e.target.value)}
                                    >
                                        {ENTITY_TYPES.map((t) => (
                                            <option key={t} value={t}>{t}</option>
                                        ))}
                                    </select>
                                </FormField>
                            </div>
                            <FormField label="Description">
                                <input
                                    className={inputCls}
                                    placeholder="Optional description…"
                                    value={newDesc}
                                    onChange={(e) => setNewDesc(e.target.value)}
                                />
                            </FormField>
                            <div className="flex gap-2 pt-1">
                                <button className={btnPrimary} onClick={handleCreate} disabled={creating}>
                                    {creating ? "Creating…" : "Create Group"}
                                </button>
                                <button className={btnGhost} onClick={() => setShowCreateForm(false)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Detail view */}
                {selected && !showCreateForm && (
                    <div className="max-w-[860px] mx-auto px-6 py-8 flex flex-col gap-5">
                        {/* Page header */}
                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <p className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 mb-1">
                                    Group
                                </p>
                                <div className="flex items-center gap-2.5 flex-wrap">
                                    <h2 className="text-xl font-bold text-gray-900 m-0 leading-tight">
                                        {selected.name ?? formatAddress(selected.address)}
                                    </h2>
                                    <span
                                        className={`inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] font-semibold tracking-wider uppercase border ${RISK_BADGE[selected.risk_level]}`}
                                    >
                                        {selected.risk_level}
                                    </span>
                                </div>
                                {selected.description && (
                                    <p className="text-[0.82rem] text-gray-500 mt-1.5 mb-0 leading-relaxed">
                                        {selected.description}
                                    </p>
                                )}
                            </div>
                            <button
                                className={editMode ? btnGhost : btnPrimary}
                                onClick={() => {
                                    if (editMode) {
                                        setPendingMembers([]);
                                        setRemovedMembers([]);
                                        setMemberInput("");
                                    }
                                    setEditMode((v) => !v);
                                }}
                            >
                                {editMode ? "Cancel" : "Edit"}
                            </button>
                        </div>

                        {/* Single combined card */}
                        <div className="bg-white border border-gray-200 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.05)] overflow-hidden">
                            {/* ── Edit section (shown first when editMode) ── */}
                            {editMode && (
                                <>
                                    <div className="px-5 py-3.5 border-b border-gray-100">
                                        <p className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 m-0">
                                            Edit Group
                                        </p>
                                    </div>
                                    <div className="px-5 py-4 flex flex-col gap-4">
                                        <div className="grid grid-cols-2 gap-4">
                                            <FormField label="Name">
                                                <input
                                                    className={inputCls}
                                                    value={editName}
                                                    onChange={(e) => setEditName(e.target.value)}
                                                />
                                            </FormField>
                                            <FormField label="Risk Level">
                                                <select
                                                    className={inputCls}
                                                    value={editRisk}
                                                    onChange={(e) => setEditRisk(e.target.value as RiskLevel)}
                                                >
                                                    {RISK_LEVELS.map((r) => (
                                                        <option key={r} value={r}>
                                                            {r}
                                                        </option>
                                                    ))}
                                                </select>
                                            </FormField>
                                        </div>
                                        <FormField label="Description">
                                            <input
                                                className={inputCls}
                                                placeholder="Optional description…"
                                                value={editDesc}
                                                onChange={(e) => setEditDesc(e.target.value)}
                                            />
                                        </FormField>
                                    </div>
                                    <div className="border-t border-gray-200" />
                                </>
                            )}

                            {/* ── Members section ── */}
                            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
                                <p className="text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 m-0">
                                    Members
                                </p>
                                <span className="text-[0.72rem] font-semibold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
                                    {selected.member_count - removedMembers.length + pendingMembers.length}
                                </span>
                            </div>

                            <div className="flex flex-col divide-y divide-gray-100">
                                {selected.members.length === 0 && pendingMembers.length === 0 && (
                                    <p className="text-[0.78rem] text-gray-400 text-center px-5 py-5 m-0">
                                        No members yet.
                                    </p>
                                )}

                                {/* Existing members */}
                                {selected.members.map((m) => {
                                    const isRemoved = removedMembers.includes(m.address);
                                    const isExpanded = !isRemoved && selectedMember?.address === m.address;
                                    return (
                                        <div key={m.address} className={isRemoved ? "opacity-40" : ""}>
                                            <div
                                                className={`flex items-center gap-2 px-5 py-2.5 transition-colors ${isRemoved ? "bg-red-50 cursor-default" : "cursor-pointer " + (isExpanded ? "bg-gray-50" : "hover:bg-gray-50")}`}
                                                onClick={() => !isRemoved && setSelectedMember(isExpanded ? null : m)}
                                            >
                                                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                    {m.name && (
                                                        <span className="text-[0.78rem] font-medium text-gray-900 truncate">
                                                            {m.name}
                                                        </span>
                                                    )}
                                                    <span className={`font-mono text-[0.68rem] break-all ${isRemoved ? "text-red-400 line-through" : "text-gray-500"}`}>
                                                        {m.address}
                                                    </span>
                                                </div>
                                                <div className="shrink-0 flex items-center gap-1.5">
                                                    {!isRemoved && (
                                                        <svg
                                                            width="12"
                                                            height="12"
                                                            viewBox="0 0 24 24"
                                                            fill="none"
                                                            stroke="currentColor"
                                                            strokeWidth="2.5"
                                                            className={`text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                                        >
                                                            <polyline points="6 9 12 15 18 9" />
                                                        </svg>
                                                    )}
                                                    {editMode && (
                                                        isRemoved ? (
                                                            <button
                                                                className="text-[0.65rem] text-red-400 underline px-1"
                                                                onClick={(e) => { e.stopPropagation(); handleUnmarkRemove(m.address); }}
                                                            >
                                                                Undo
                                                            </button>
                                                        ) : (
                                                            <button
                                                                className="w-6 h-6 flex items-center justify-center rounded border-none bg-transparent cursor-pointer text-gray-300 transition-colors hover:text-red-500 hover:bg-red-50"
                                                                onClick={(e) => { e.stopPropagation(); handleMarkRemove(m.address); }}
                                                                title="Remove member"
                                                            >
                                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                                </svg>
                                                            </button>
                                                        )
                                                    )}
                                                </div>
                                            </div>
                                            {isExpanded && (
                                                <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex flex-col gap-3">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {m.entity_type && (
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                                                                    {m.entity_type}
                                                                </span>
                                                            )}
                                                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] font-semibold border ${RISK_BADGE[m.risk_level]}`}>
                                                                {m.risk_level}
                                                            </span>
                                                            {m.labels.map((l) => (
                                                                <span key={l} className="inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] text-gray-800 border border-gray-200">
                                                                    {l}
                                                                </span>
                                                            ))}
                                                        </div>
                                                        <button
                                                            className="inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] text-gray-900 underline"
                                                            onClick={() => onNavigateToExplorer(m.address)}
                                                        >
                                                            View in Explorer
                                                        </button>
                                                    </div>
                                                    {(m.transaction_count != null || m.first_seen_block != null) && (
                                                        <div className="flex gap-4">
                                                            {m.transaction_count != null && (
                                                                <div className="flex flex-col gap-0.5">
                                                                    <span className="text-[0.65rem] text-gray-400 uppercase tracking-wider">Txns</span>
                                                                    <span className="text-[0.82rem] font-semibold text-gray-900">{m.transaction_count.toLocaleString()}</span>
                                                                </div>
                                                            )}
                                                            {m.first_seen_block != null && (
                                                                <div className="flex flex-col gap-0.5">
                                                                    <span className="text-[0.65rem] text-gray-400 uppercase tracking-wider">First block</span>
                                                                    <span className="text-[0.82rem] font-semibold text-gray-900">#{m.first_seen_block.toLocaleString()}</span>
                                                                </div>
                                                            )}
                                                            {m.last_seen_block != null && (
                                                                <div className="flex flex-col gap-0.5">
                                                                    <span className="text-[0.65rem] text-gray-400 uppercase tracking-wider">Last block</span>
                                                                    <span className="text-[0.82rem] font-semibold text-gray-900">#{m.last_seen_block.toLocaleString()}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}

                                {/* Pending (staged) members */}
                                {pendingMembers.map((addr) => (
                                    <div key={addr} className="flex items-center gap-2 px-5 py-2.5 bg-green-50">
                                        <div className="flex-1 min-w-0">
                                            <span className="font-mono text-[0.68rem] text-green-700 break-all">{addr}</span>
                                            <span className="ml-2 text-[0.62rem] text-green-500 font-semibold uppercase tracking-wider">pending</span>
                                        </div>
                                        <button
                                            className="w-6 h-6 flex items-center justify-center rounded border-none bg-transparent cursor-pointer text-green-300 transition-colors hover:text-red-500 hover:bg-red-50"
                                            onClick={() => handleUnstageMember(addr)}
                                            title="Remove staged member"
                                        >
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <line x1="18" y1="6" x2="6" y2="18" />
                                                <line x1="6" y1="6" x2="18" y2="18" />
                                            </svg>
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {/* Add member input — only shown in edit mode */}
                            {editMode && (
                                <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
                                    <input
                                        className="w-full bg-white border border-gray-200 rounded-lg px-2.5 py-[6px] font-mono text-[0.72rem] text-gray-900 outline-none transition-all placeholder-gray-400 focus:border-indigo-400 focus:shadow-[0_0_0_2px_rgba(99,102,241,0.15)]"
                                        placeholder="0x… type address and press Enter to stage"
                                        value={memberInput}
                                        onChange={(e) => setMemberInput(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleStageMember(); } }}
                                    />
                                </div>
                            )}

                            {/* Action buttons — only shown in edit mode */}
                            {editMode && (
                                <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-gray-200">
                                    <button className={btnPrimary} onClick={handleSave} disabled={saving}>
                                        {saving ? "Saving…" : "Save Changes"}
                                    </button>
                                    <button
                                        className={btnDangerSm}
                                        onClick={handleDelete}
                                        disabled={selected.member_count > 0}
                                        title={
                                            selected.member_count > 0
                                                ? "Remove all members before deleting"
                                                : "Delete group"
                                        }
                                    >
                                        Delete Group
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {!selected && !showCreateForm && (
                    <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5">
                            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                            <circle cx="9" cy="7" r="4" />
                            <path d="M23 21v-2a4 4 0 00-3-3.87" />
                            <path d="M16 3.13a4 4 0 010 7.75" />
                        </svg>
                        <p className="text-[0.8rem] text-gray-400 m-0">Select a group or create a new one</p>
                    </div>
                )}
            </div>
        </div>
    );
}
