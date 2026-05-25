import { useCallback, useEffect, useRef, useState } from "react";
import { useToastContext } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { createAdminUser, deleteAdminUser, fetchAdminUsers, updateAdminUser } from "../api/client";
import {
    btnDangerSm,
    btnPrimary,
    btnSecondary,
    inputCls,
    sectionLabel,
    selectCls,
} from "../constants";
import type {
    AdminUserCreateRequest,
    AdminUserUpdateRequest,
    UserResponse,
    UserRole,
} from "../types";
import { Badge } from "../components/ui/Badge";
import { USER_ROLE_TONE, type Tone } from "../components/ui/tokens";

type RoleFilter = "all" | UserRole;

const ROLE_OPTIONS: UserRole[] = ["admin", "operator", "user"];
const ROLE_LABELS: Record<UserRole, string> = {
    admin: "Admin",
    operator: "Operator",
    user: "User",
};

function emptyCreateForm(): AdminUserCreateRequest {
    return {
        username: "",
        email: "",
        password: "",
        role: "operator",
        is_active: true,
    };
}

function buildEditForm(user: UserResponse): AdminUserUpdateRequest {
    return {
        username: user.username,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
    };
}

function sortUsers(users: UserResponse[]): UserResponse[] {
    const roleOrder: Record<UserRole, number> = {
        admin: 0,
        operator: 1,
        user: 2,
    };

    return [...users].sort((left, right) => {
        const roleDiff = roleOrder[left.role] - roleOrder[right.role];
        if (roleDiff !== 0) return roleDiff;
        return left.username.localeCompare(right.username);
    });
}

function formatDate(value?: string | null): string {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString();
}

export function AdminUsersPage() {
    const toast = useToastContext();
    const { user: currentUser } = useAuth();
    const editSectionRef = useRef<HTMLElement | null>(null);

    const [users, setUsers] = useState<UserResponse[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

    const [createForm, setCreateForm] = useState<AdminUserCreateRequest>(emptyCreateForm);
    const [createLoading, setCreateLoading] = useState(false);

    const [editingUserId, setEditingUserId] = useState<number | null>(null);
    const [editForm, setEditForm] = useState<AdminUserUpdateRequest>({});
    const [saveLoading, setSaveLoading] = useState(false);
    const [rowActionId, setRowActionId] = useState<number | null>(null);

    const loadUsers = useCallback(async () => {
        setLoading(true);
        try {
            const response = await fetchAdminUsers();
            setUsers(sortUsers(response.users));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Unable to load users");
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        loadUsers();
    }, [loadUsers]);

    useEffect(() => {
        if (editingUserId === null) return;
        editSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [editingUserId]);

    const editingUser = users.find((entry) => entry.id === editingUserId) ?? null;

    const filteredUsers = users.filter((entry) => {
        const roleMatches = roleFilter === "all" || entry.role === roleFilter;
        const term = search.trim().toLowerCase();
        if (!term) return roleMatches;
        return (
            roleMatches &&
            (entry.username.toLowerCase().includes(term) ||
                entry.email.toLowerCase().includes(term) ||
                ROLE_LABELS[entry.role].toLowerCase().includes(term))
        );
    });

    const totalAdmins = users.filter((entry) => entry.role === "admin").length;
    const totalOperators = users.filter((entry) => entry.role === "operator").length;
    const totalUsers = users.filter((entry) => entry.role === "user").length;
    const totalActive = users.filter((entry) => entry.is_active).length;

    function updateLocalUser(nextUser: UserResponse) {
        setUsers((current) => sortUsers(current.map((entry) => (entry.id === nextUser.id ? nextUser : entry))));
        if (editingUserId === nextUser.id) {
            setEditForm(buildEditForm(nextUser));
        }
    }

    function validateCreateForm() {
        if (!createForm.username.trim() || !createForm.email.trim() || !createForm.password) {
            toast.error("Username, email, and password are required.");
            return false;
        }
        return true;
    }

    async function handleCreate() {
        if (!validateCreateForm()) return;
        setCreateLoading(true);
        const toastId = toast.loading("Creating account…");
        try {
            const created = await createAdminUser({
                ...createForm,
                username: createForm.username.trim(),
                email: createForm.email.trim(),
            });
            setUsers((current) => sortUsers([created, ...current]));
            setCreateForm(emptyCreateForm());
            toast.dismiss(toastId);
            toast.success(`Created ${ROLE_LABELS[created.role].toLowerCase()} account for ${created.username}.`);
        } catch (err) {
            toast.dismiss(toastId);
            toast.error(err instanceof Error ? err.message : "Unable to create user");
        } finally {
            setCreateLoading(false);
        }
    }

    function startEditing(target: UserResponse) {
        setEditingUserId(target.id);
        setEditForm(buildEditForm(target));
    }

    function cancelEditing() {
        setEditingUserId(null);
        setEditForm({});
    }

    async function handleSave() {
        if (!editingUser) return;
        if (!editForm.username?.trim() || !editForm.email?.trim()) {
            toast.error("Username and email are required.");
            return;
        }

        setSaveLoading(true);
        const toastId = toast.loading("Saving changes…");
        try {
            const payload: AdminUserUpdateRequest = {
                username: editForm.username.trim(),
                email: editForm.email.trim(),
                role: editForm.role,
                is_active: editForm.is_active,
                ...(editForm.password ? { password: editForm.password } : {}),
            };
            const updated = await updateAdminUser(editingUser.id, payload);
            updateLocalUser(updated);
            cancelEditing();
            toast.dismiss(toastId);
            toast.success(`Updated ${updated.username}.`);
        } catch (err) {
            toast.dismiss(toastId);
            toast.error(err instanceof Error ? err.message : "Unable to save changes");
        } finally {
            setSaveLoading(false);
        }
    }

    async function handleToggleActive(target: UserResponse) {
        setRowActionId(target.id);
        const nextState = !target.is_active;
        const toastId = toast.loading(nextState ? "Activating account…" : "Deactivating account…");
        try {
            const updated = await updateAdminUser(target.id, { is_active: nextState });
            updateLocalUser(updated);
            toast.dismiss(toastId);
            toast.success(`${updated.username} is now ${updated.is_active ? "active" : "inactive"}.`);
        } catch (err) {
            toast.dismiss(toastId);
            toast.error(err instanceof Error ? err.message : "Unable to update status");
        } finally {
            setRowActionId(null);
        }
    }

    async function handleDelete(target: UserResponse) {
        const confirmed = window.confirm(`Delete ${target.username}? This cannot be undone.`);
        if (!confirmed) return;

        setRowActionId(target.id);
        const toastId = toast.loading("Deleting account…");
        try {
            await deleteAdminUser(target.id);
            setUsers((current) => current.filter((entry) => entry.id !== target.id));
            if (editingUserId === target.id) {
                cancelEditing();
            }
            toast.dismiss(toastId);
            toast.success(`Deleted ${target.username}.`);
        } catch (err) {
            toast.dismiss(toastId);
            toast.error(err instanceof Error ? err.message : "Unable to delete user");
        } finally {
            setRowActionId(null);
        }
    }

    return (
        <div className="flex-1 min-h-0 overflow-auto bg-[var(--bg-primary)]">
            <div className="max-w-[1180px] mx-auto px-6 py-8">
                <div className="flex flex-col gap-2 mb-7">
                    <p className={sectionLabel}>Administration</p>
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                        <div>
                            <h1 className="text-2xl font-bold tracking-tight text-gray-900 m-0">
                                Operator & User Management
                            </h1>
                            <p className="text-[0.88rem] text-gray-500 mt-2 mb-0">
                                Create accounts, update roles, and control who can access the platform.
                            </p>
                        </div>
                        <button onClick={loadUsers} disabled={loading} className={btnSecondary}>
                            {loading ? "Refreshing…" : "Refresh"}
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                    <SummaryCard label="Active Accounts" value={String(totalActive)} tone="success" />
                    <SummaryCard label="Operators" value={String(totalOperators)} tone="info" />
                    <SummaryCard label="Users" value={String(totalUsers)} tone="success" />
                    <SummaryCard label="Admins" value={String(totalAdmins)} tone="accent" />
                </div>

                <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
                    <section className="bg-white border border-gray-200 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                        <div className="mb-4">
                            <p className={sectionLabel}>Create Account</p>
                            <h2 className="text-lg font-semibold text-gray-900 m-0">Add account</h2>
                        </div>

                        <div className="space-y-3">
                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Username</span>
                                <input
                                    value={createForm.username}
                                    onChange={(event) =>
                                        setCreateForm((current) => ({ ...current, username: event.target.value }))
                                    }
                                    className={inputCls}
                                    placeholder="jane.operator"
                                />
                            </label>

                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Email</span>
                                <input
                                    value={createForm.email}
                                    onChange={(event) =>
                                        setCreateForm((current) => ({ ...current, email: event.target.value }))
                                    }
                                    className={inputCls}
                                    placeholder="jane@example.com"
                                    type="email"
                                />
                            </label>

                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Password</span>
                                <input
                                    value={createForm.password}
                                    onChange={(event) =>
                                        setCreateForm((current) => ({ ...current, password: event.target.value }))
                                    }
                                    className={inputCls}
                                    placeholder="Temporary password"
                                    type="password"
                                />
                            </label>

                            <div className="grid grid-cols-2 gap-3">
                                <label className="block">
                                    <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Role</span>
                                    <select
                                        value={createForm.role}
                                        onChange={(event) =>
                                            setCreateForm((current) => ({
                                                ...current,
                                                role: event.target.value as UserRole,
                                            }))
                                        }
                                        className={`${selectCls} w-full`}
                                    >
                                        {ROLE_OPTIONS.map((role) => (
                                            <option key={role} value={role}>
                                                {ROLE_LABELS[role]}
                                            </option>
                                        ))}
                                    </select>
                                </label>

                                <label className="block">
                                    <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Status</span>
                                    <select
                                        value={createForm.is_active ? "active" : "inactive"}
                                        onChange={(event) =>
                                            setCreateForm((current) => ({
                                                ...current,
                                                is_active: event.target.value === "active",
                                            }))
                                        }
                                        className={`${selectCls} w-full`}
                                    >
                                        <option value="active">Active</option>
                                        <option value="inactive">Inactive</option>
                                    </select>
                                </label>
                            </div>

                            <button onClick={handleCreate} disabled={createLoading} className={`${btnPrimary} w-full`}>
                                {createLoading ? "Creating…" : "Create account"}
                            </button>
                        </div>
                    </section>

                    <section className="bg-white border border-gray-200 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)] min-w-0">
                        <div className="flex flex-col gap-4 mb-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className={sectionLabel}>Directory</p>
                                <h2 className="text-lg font-semibold text-gray-900 m-0">Accounts</h2>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    className={`${inputCls} min-w-[220px]`}
                                    placeholder="Search username or email"
                                />
                                <select
                                    value={roleFilter}
                                    onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
                                    className={`${selectCls} min-w-[140px]`}
                                >
                                    <option value="all">All roles</option>
                                    {ROLE_OPTIONS.map((role) => (
                                        <option key={role} value={role}>
                                            {ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full border-separate border-spacing-0">
                                <thead>
                                    <tr>
                                        <TableHead>Name</TableHead>
                                        <TableHead>Role</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Created</TableHead>
                                        <TableHead align="right">Actions</TableHead>
                                    </tr>
                                </thead>
                                <tbody>
                                    {loading ? (
                                        <tr>
                                            <td colSpan={5} className="py-10 text-center text-[0.82rem] text-gray-400">
                                                Loading accounts…
                                            </td>
                                        </tr>
                                    ) : filteredUsers.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="py-10 text-center text-[0.82rem] text-gray-400">
                                                No accounts match the current filters.
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredUsers.map((entry) => {
                                            const isSelf = currentUser?.id === entry.id;
                                            const rowBusy = rowActionId === entry.id;
                                            const isEditing = editingUserId === entry.id;
                                            return (
                                                <tr key={entry.id} className={isEditing ? "bg-slate-50/70" : undefined}>
                                                    <td className="py-3 pr-4 border-t border-gray-100">
                                                        <div className="min-w-[220px]">
                                                            <div className="flex items-center gap-2">
                                                                <p className="text-[0.82rem] font-semibold text-gray-900 m-0">
                                                                    {entry.username}
                                                                </p>
                                                                {isEditing && (
                                                                    <span className="inline-flex px-2 py-0.5 rounded-full border border-slate-200 bg-white text-[0.66rem] font-semibold text-slate-600">
                                                                        Editing
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="text-[0.74rem] text-gray-500 mt-1 mb-0">
                                                                {entry.email}
                                                            </p>
                                                        </div>
                                                    </td>
                                                    <td className="py-3 pr-4 border-t border-gray-100">
                                                        <Badge tone={USER_ROLE_TONE[entry.role]}>
                                                            {ROLE_LABELS[entry.role]}
                                                        </Badge>
                                                    </td>
                                                    <td className="py-3 pr-4 border-t border-gray-100">
                                                        <Badge tone={entry.is_active ? "success" : "neutral"}>
                                                            {entry.is_active ? "Active" : "Inactive"}
                                                        </Badge>
                                                    </td>
                                                    <td className="py-3 pr-4 border-t border-gray-100 text-[0.75rem] text-gray-500">
                                                        {formatDate(entry.created_at)}
                                                    </td>
                                                    <td className="py-3 border-t border-gray-100">
                                                        <div className="flex justify-end gap-2">
                                                            <button
                                                                onClick={() => startEditing(entry)}
                                                                className={btnSecondary}
                                                            >
                                                                {isEditing ? "Editing…" : "Edit"}
                                                            </button>
                                                            <button
                                                                onClick={() => handleToggleActive(entry)}
                                                                disabled={rowBusy || (isSelf && entry.is_active)}
                                                                className={btnSecondary}
                                                                title={
                                                                    isSelf && entry.is_active
                                                                        ? "You cannot deactivate your own account."
                                                                        : undefined
                                                                }
                                                            >
                                                                {rowBusy
                                                                    ? "Working…"
                                                                    : entry.is_active
                                                                      ? "Deactivate"
                                                                      : "Activate"}
                                                            </button>
                                                            <button
                                                                onClick={() => handleDelete(entry)}
                                                                disabled={rowBusy || isSelf}
                                                                className={btnDangerSm}
                                                                title={
                                                                    isSelf
                                                                        ? "You cannot delete your own account."
                                                                        : undefined
                                                                }
                                                            >
                                                                Delete
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

                {editingUser && (
                    <section
                        ref={editSectionRef}
                        className="mt-5 bg-white border border-gray-200 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]"
                    >
                        <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className={sectionLabel}>Edit Account</p>
                                <h2 className="text-lg font-semibold text-gray-900 m-0">{editingUser.username}</h2>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={cancelEditing} className={btnSecondary}>
                                    Cancel
                                </button>
                                <button onClick={handleSave} disabled={saveLoading} className={btnPrimary}>
                                    {saveLoading ? "Saving…" : "Save changes"}
                                </button>
                            </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Username</span>
                                <input
                                    value={editForm.username ?? ""}
                                    onChange={(event) =>
                                        setEditForm((current) => ({ ...current, username: event.target.value }))
                                    }
                                    className={inputCls}
                                />
                            </label>

                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Email</span>
                                <input
                                    value={editForm.email ?? ""}
                                    onChange={(event) =>
                                        setEditForm((current) => ({ ...current, email: event.target.value }))
                                    }
                                    className={inputCls}
                                    type="email"
                                />
                            </label>

                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">Role</span>
                                <select
                                    value={editForm.role ?? editingUser.role}
                                    onChange={(event) =>
                                        setEditForm((current) => ({
                                            ...current,
                                            role: event.target.value as UserRole,
                                        }))
                                    }
                                    className={`${selectCls} w-full`}
                                >
                                    {ROLE_OPTIONS.map((role) => (
                                        <option
                                            key={role}
                                            value={role}
                                            disabled={editingUser.id === currentUser?.id && role !== "admin"}
                                        >
                                            {ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">
                                    Status
                                </span>
                                <select
                                    value={(editForm.is_active ?? editingUser.is_active) ? "active" : "inactive"}
                                    onChange={(event) =>
                                        setEditForm((current) => ({
                                            ...current,
                                            is_active: event.target.value === "active",
                                        }))
                                    }
                                    disabled={editingUser.id === currentUser?.id}
                                    className={`${selectCls} w-full disabled:bg-gray-50 disabled:text-gray-400`}
                                >
                                    <option value="active">Active</option>
                                    <option value="inactive">Inactive</option>
                                </select>
                            </label>
                        </div>

                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_240px] mt-4">
                            <label className="block">
                                <span className="text-[0.75rem] font-medium text-gray-600 block mb-1.5">
                                    New password
                                </span>
                                <input
                                    value={editForm.password ?? ""}
                                    onChange={(event) =>
                                        setEditForm((current) => ({ ...current, password: event.target.value }))
                                    }
                                    className={inputCls}
                                    type="password"
                                    placeholder="Leave blank to keep the current password"
                                />
                            </label>
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[0.75rem] text-gray-500">
                                Created {formatDate(editingUser.created_at)}
                                <br />
                                Updated {formatDate(editingUser.updated_at)}
                            </div>
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}

function SummaryCard({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone: Tone;
}) {
    return (
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
            <Badge tone={tone} size="sm">{label}</Badge>
            <div className="mt-3 text-2xl font-bold tracking-tight text-gray-900">{value}</div>
        </div>
    );
}

function TableHead({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
    return (
        <th
            className={`pb-2 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-gray-400 ${
                align === "right" ? "text-right" : "text-left"
            }`}
        >
            {children}
        </th>
    );
}
