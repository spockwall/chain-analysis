/**
 * Node details panel — Oravia style
 */
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { EntityResponse, TransactionResponse } from "../types";
import {
    formatAddress,
    formatWei,
    fetchGroupMembers,
    addGroupMember,
    removeGroupMember,
    ingestAddress,
    enqueueLabelFetch,
} from "../api/client";
import { useToastContext } from "../context/ToastContext";
import { useIngestionRuns } from "../context/IngestionRunsContext";
import { RISK_BADGE, ENTITY_LABEL, sectionLabel, labelCls } from "../constants";
import { CopyButton } from "./CopyButton";
import { useNicknames } from "../context/NicknamesContext";
import { useAuth } from "../context/AuthContext";

interface NodePanelProps {
    node: EntityResponse;
    onExpand: () => void;
    onClose: () => void;
    transactions?: TransactionResponse[];
    onNavigateToAddress?: (address: string) => void;
    overrideMembers?: EntityResponse[];
    onIngestComplete?: (address: string) => void;
}

const divider = "border-none border-t border-gray-100 m-0";
const btnIcon =
    "w-[26px] h-[26px] flex items-center justify-center border border-gray-200 rounded bg-transparent cursor-pointer text-gray-500 p-0 transition-colors hover:bg-gray-100 hover:text-gray-900";

export function NodePanel({
    node,
    onExpand,
    onClose,
    transactions,
    onNavigateToAddress,
    overrideMembers,
    onIngestComplete,
}: NodePanelProps) {
    const entityType = node.entity_type || "Unknown";
    const toast = useToastContext();
    const navigate = useNavigate();
    const { track: trackRun, trackTask } = useIngestionRuns();
    const { getNickname, setNickname, removeNickname } = useNicknames();
    const { isAuthenticated } = useAuth();

    // Inline nickname editor state — reset whenever a different node is shown.
    const currentNickname = getNickname(node.address);
    const [editingNickname, setEditingNickname] = useState(false);
    const [nicknameInput, setNicknameInput] = useState(currentNickname ?? "");
    useEffect(() => {
        setEditingNickname(false);
        setNicknameInput(getNickname(node.address) ?? "");
    }, [node.address, getNickname]);

    const handleSaveNickname = async () => {
        const trimmed = nicknameInput.trim();
        if (!trimmed) {
            if (currentNickname) {
                try {
                    await removeNickname(node.address);
                    toast.info("Nickname cleared");
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to clear nickname");
                    return;
                }
            }
            setEditingNickname(false);
            return;
        }
        try {
            await setNickname(node.address, trimmed);
            toast.success("Nickname saved");
            setEditingNickname(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save nickname");
        }
    };

    const [members, setMembers] = useState<EntityResponse[]>([]);
    const [memberInput, setMemberInput] = useState("");
    const [membersLoading, setMembersLoading] = useState(false);
    const [ingesting, setIngesting] = useState(false);
    const [tracing, setTracing] = useState(false);

    useEffect(() => {
        let cancelled = false;

        if (overrideMembers) {
            setMembers(overrideMembers);
            setMembersLoading(false);
            return;
        }

        setMembers([]);
        setMemberInput("");
        setMembersLoading(true);
        fetchGroupMembers(node.address)
            .then((res) => {
                if (!cancelled) setMembers(res.members);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setMembersLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [node.address, overrideMembers]);

    const handleAddMember = async () => {
        const addr = memberInput.trim();
        if (!addr) return;
        try {
            const res = await addGroupMember(node.address, addr);
            setMembers(res.members);
            setMemberInput("");
            toast.success(`Added ${formatAddress(addr, 4)} as member`);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to add member");
        }
    };

    const handleRemoveMember = async (childAddress: string) => {
        try {
            await removeGroupMember(node.address, childAddress);
            setMembers((prev) => prev.filter((m) => m.address !== childAddress));
            toast.success(`Removed ${formatAddress(childAddress, 4)}`);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to remove member");
        }
    };

    const handleIngest = async () => {
        setIngesting(true);
        try {
            const result = await ingestAddress({ address: node.address });
            toast.success(`Queued ingest for ${formatAddress(node.address, 4)} — see run pill for progress`);
            trackRun(result.run_id, {
                onComplete: (run) => {
                    if (run.status === "completed") {
                        toast.success(`Ingest complete — ${run.transactions_processed} txs`);
                        onIngestComplete?.(node.address);
                    } else {
                        toast.error(`Ingest failed${run.error_message ? `: ${run.error_message}` : ""}`);
                    }
                },
            });
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Ingestion failed");
        } finally {
            setIngesting(false);
        }
    };

    const handleDeepTrace = async () => {
        setTracing(true);
        try {
            const res = await enqueueLabelFetch({ mode: "neighborhood", seed: node.address, hops: 1 });
            toast.success("Queued neighborhood fetch — worker will pick up within seconds");
            const taskId = res.task_ids?.[0];
            if (taskId) {
                trackTask(taskId, {
                    onComplete: (task) => {
                        if (task.status === "completed") {
                            toast.success("Neighborhood fetch complete");
                            onIngestComplete?.(node.address);
                        } else {
                            toast.error(`Neighborhood fetch ${task.status}`);
                        }
                    },
                });
            }
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to queue neighborhood fetch");
        } finally {
            setTracing(false);
        }
    };

    const txForNode = (transactions ?? []).filter(
        (tx) => tx.from_address === node.address || tx.to_address === node.address,
    );

    return (
        <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
                <div className="flex-1 min-w-0">
                    <p className={`${sectionLabel} mb-1`}>
                        {(node.member_count ?? 0) > 0 ? "Selected Group" : "Selected Entity"}
                    </p>
                    {/* Title: entity.name > user nickname > "Unknown Entity" */}
                    <h2 className="text-[1.25rem] font-semibold tracking-[-0.01em] text-gray-900 mb-1">
                        {node.name || currentNickname || "Unknown Entity"}
                    </h2>
                    {/* Nickname row — shown when the user has set one *and* there's a global entity name above */}
                    {node.name && currentNickname && !editingNickname && (
                        <p className="text-[0.7rem] text-violet-600 mb-1">
                            <span className="font-semibold mr-1">Your nickname:</span>
                            {currentNickname}
                        </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <p className="font-mono text-[0.72rem] text-gray-600 truncate flex-1 min-w-0 m-0">
                            {node.address}
                        </p>
                        <CopyButton
                            text={node.address}
                            onCopy={() => toast.success("Address copied")}
                            onError={() => toast.error("Copy failed")}
                        />
                    </div>
                    {/* Inline nickname editor */}
                    {isAuthenticated && (
                        <div className="mt-2">
                            {editingNickname ? (
                                <div className="flex gap-1.5 items-center">
                                    <input
                                        autoFocus
                                        type="text"
                                        className="flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-[0.72rem] text-gray-900 outline-none focus:border-violet-400"
                                        placeholder="Nickname (leave blank to clear)"
                                        value={nicknameInput}
                                        maxLength={255}
                                        onChange={(e) => setNicknameInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleSaveNickname();
                                            else if (e.key === "Escape") {
                                                setEditingNickname(false);
                                                setNicknameInput(currentNickname ?? "");
                                            }
                                        }}
                                    />
                                    <button
                                        className="shrink-0 px-2 py-1 bg-violet-600 text-white text-[0.68rem] font-semibold rounded border-none cursor-pointer hover:bg-violet-700"
                                        onClick={handleSaveNickname}
                                    >
                                        Save
                                    </button>
                                    <button
                                        className="shrink-0 px-2 py-1 bg-white text-gray-500 text-[0.68rem] font-semibold rounded border border-gray-200 cursor-pointer hover:bg-gray-50"
                                        onClick={() => {
                                            setEditingNickname(false);
                                            setNicknameInput(currentNickname ?? "");
                                        }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <button
                                    className="text-[0.7rem] text-violet-600 hover:underline cursor-pointer bg-transparent border-none p-0"
                                    onClick={() => setEditingNickname(true)}
                                >
                                    {currentNickname ? "Edit nickname" : "Add nickname"}
                                </button>
                            )}
                        </div>
                    )}
                </div>
                <button className={btnIcon} onClick={onClose} aria-label="Close panel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 overflow-y-auto flex-1 flex flex-col gap-5">
                {/* Classification */}
                <div>
                    <p className={sectionLabel}>Classification</p>
                    <div className="flex flex-wrap gap-1.5">
                        <span
                            className={`inline-flex items-center gap-1 px-2 py-[3px] rounded text-[0.65rem] font-semibold tracking-[0.04em] uppercase ${RISK_BADGE[node.risk_level]}`}
                        >
                            {node.risk_level}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-[3px] rounded text-[0.65rem] font-semibold tracking-[0.04em] uppercase text-violet-500 border border-violet-500">
                            {ENTITY_LABEL[entityType]}
                        </span>
                        {(node.member_count ?? 0) > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-[3px] rounded text-[0.65rem] font-semibold tracking-[0.04em] uppercase bg-violet-600 text-white border border-violet-600">
                                <svg
                                    width="9"
                                    height="9"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                >
                                    <circle cx="9" cy="7" r="4" />
                                    <path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
                                    <path d="M16 3.13a4 4 0 010 7.75" />
                                    <path d="M21 21v-2a4 4 0 00-3-3.87" />
                                </svg>
                                Group · {node.member_count} member{node.member_count === 1 ? "" : "s"}
                            </span>
                        )}
                    </div>
                </div>

                <hr className={divider} />

                {/* Stats */}
                {(node.transaction_count != null || node.first_seen_block || node.last_seen_block) && (
                    <>
                        <div>
                            <p className={sectionLabel}>Activity</p>
                            <div className="grid grid-cols-2 gap-3">
                                {node.transaction_count != null && (
                                    <div>
                                        <div className="text-[1.4rem] font-bold text-gray-900 tracking-[-0.02em] leading-none">
                                            {node.transaction_count.toLocaleString()}
                                        </div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">Transactions</div>
                                    </div>
                                )}
                                {node.first_seen_block && (
                                    <div>
                                        <div className="text-[1rem] font-bold text-gray-900 leading-none">
                                            #{node.first_seen_block.toLocaleString()}
                                        </div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">First seen</div>
                                    </div>
                                )}
                                {node.last_seen_block && (
                                    <div>
                                        <div className="text-[1rem] font-bold text-gray-900 leading-none">
                                            #{node.last_seen_block.toLocaleString()}
                                        </div>
                                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">Last seen</div>
                                    </div>
                                )}
                            </div>
                        </div>
                        <hr className={divider} />
                    </>
                )}

                {/* Labels */}
                {node.labels.length > 0 && (
                    <>
                        <div>
                            <p className={sectionLabel}>Labels</p>
                            <div className="flex flex-wrap gap-1">
                                {node.labels.map((label) => (
                                    <span key={label} className={labelCls}>
                                        {label}
                                    </span>
                                ))}
                            </div>
                        </div>
                        <hr className={divider} />
                    </>
                )}

                {/* Actions */}
                <div>
                    <p className={sectionLabel}>Actions</p>
                    <div className="flex flex-col gap-1.5">
                        <button
                            className="w-full px-3.5 py-[9px] rounded-lg text-[0.78rem] font-semibold font-[inherit] cursor-pointer flex items-center justify-between transition-colors bg-gray-900 text-white border-none hover:bg-[#1e293b]"
                            onClick={onExpand}
                        >
                            Expand Neighbours
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                            >
                                <line x1="5" y1="12" x2="19" y2="12" />
                                <polyline points="12 5 19 12 12 19" />
                            </svg>
                        </button>
                        <button
                            className="w-full px-3.5 py-[9px] rounded-lg text-[0.78rem] font-semibold font-[inherit] cursor-pointer flex items-center justify-between transition-colors bg-blue-600 text-white border-none hover:bg-blue-700 disabled:opacity-45 disabled:cursor-not-allowed"
                            onClick={handleIngest}
                            disabled={ingesting}
                        >
                            {ingesting ? "Fetching…" : "Fetch Transactions"}
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                            >
                                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                        </button>
                        <button
                            className="w-full px-3.5 py-[9px] rounded-lg text-[0.78rem] font-semibold font-[inherit] cursor-pointer flex items-center justify-between transition-colors bg-white text-gray-900 border border-gray-200 hover:bg-gray-50 disabled:opacity-45 disabled:cursor-not-allowed"
                            onClick={handleDeepTrace}
                            disabled={tracing}
                            title="Queue a 2-hop neighborhood ingest via the Rust ETL worker"
                        >
                            {tracing ? "Queueing…" : "Deep trace (1 hop)"}
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                            >
                                <circle cx="12" cy="12" r="3" />
                                <circle cx="4" cy="6" r="2" />
                                <circle cx="20" cy="6" r="2" />
                                <circle cx="4" cy="18" r="2" />
                                <circle cx="20" cy="18" r="2" />
                                <line x1="12" y1="12" x2="4" y2="6" />
                                <line x1="12" y1="12" x2="20" y2="6" />
                                <line x1="12" y1="12" x2="4" y2="18" />
                                <line x1="12" y1="12" x2="20" y2="18" />
                            </svg>
                        </button>
                        <button
                            className="w-full px-3.5 py-[9px] rounded-lg text-[0.78rem] font-semibold font-[inherit] cursor-pointer flex items-center justify-between transition-colors bg-white text-gray-900 border border-gray-200 hover:bg-gray-50"
                            onClick={() => navigate(`/labels?address=${encodeURIComponent(node.address)}`)}
                        >
                            Label this entity
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                            >
                                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                                <line x1="7" y1="7" x2="7.01" y2="7" />
                            </svg>
                        </button>
                        <a
                            href={`https://etherscan.io/address/${node.address}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full px-3.5 py-[9px] rounded-lg text-[0.78rem] font-semibold cursor-pointer flex items-center justify-between transition-colors bg-white text-gray-900 border border-gray-200 no-underline hover:bg-gray-50"
                        >
                            View on Etherscan
                            <svg
                                width="11"
                                height="11"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                        </a>
                    </div>
                </div>

                {/* Group Members */}
                <hr className={divider} />
                <div>
                    <p className={sectionLabel}>
                        Group Members
                        {members.length > 0 && (
                            <span className="inline-flex items-center justify-center bg-violet-600 text-white rounded-full text-[0.6rem] font-semibold min-w-[16px] h-4 px-1 leading-none ml-1.5 align-middle">
                                {members.length}
                            </span>
                        )}
                    </p>
                    {membersLoading ? (
                        <p className="text-[0.7rem] text-gray-400">Loading…</p>
                    ) : (
                        <>
                            {members.length === 0 && (node.member_count ?? 0) === 0 && (
                                <p className="text-[0.7rem] text-gray-400 italic">
                                    No members — this is not a group node.
                                </p>
                            )}
                            {members.length > 0 && (
                                <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto mb-1.5">
                                    {members.map((m) => (
                                        <div
                                            key={m.address}
                                            className="flex items-center gap-1.5 px-1 py-[4px] rounded border border-gray-200 hover:bg-gray-50 transition-colors"
                                        >
                                            {/* Clickable name + address */}
                                            <button
                                                className="flex-1 text-left bg-none border-none cursor-pointer p-0 truncate"
                                                title={m.address}
                                                onClick={() => onNavigateToAddress?.(m.address)}
                                            >
                                                {m.name && (
                                                    <span className="block text-[0.72rem] font-semibold text-gray-800 truncate leading-snug">
                                                        {m.name}
                                                    </span>
                                                )}
                                                <span
                                                    className={`block font-mono text-[0.66rem] truncate leading-snug ${m.name ? "text-gray-500" : "text-gray-900 hover:underline"}`}
                                                >
                                                    {formatAddress(m.address, 5)}
                                                </span>
                                            </button>
                                            {m.entity_type && (
                                                <span className="shrink-0 inline-flex items-center px-[5px] py-[1px] rounded text-[0.6rem] font-semibold uppercase border border-violet-500 text-violet-600">
                                                    {m.entity_type}
                                                </span>
                                            )}
                                            <button
                                                className="shrink-0 flex items-center justify-center w-5 h-5 border border-gray-200 rounded bg-transparent cursor-pointer text-gray-400 text-base leading-none p-0 transition-colors hover:text-red-500 hover:border-red-300"
                                                title="Remove member"
                                                onClick={() => handleRemoveMember(m.address)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="flex gap-1.5 items-center mt-1">
                                <input
                                    className="flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded px-2 py-1 font-mono text-[0.68rem] text-gray-900 outline-none focus:border-violet-400"
                                    type="text"
                                    placeholder="0x… member address"
                                    value={memberInput}
                                    onChange={(e) => setMemberInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleAddMember();
                                    }}
                                />
                                <button
                                    className="shrink-0 px-2.5 py-1 bg-violet-600 text-white text-[0.7rem] font-semibold rounded border-none cursor-pointer transition-colors hover:bg-violet-700"
                                    onClick={handleAddMember}
                                >
                                    Add
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {/* Transaction list */}
                {txForNode.length > 0 && (
                    <>
                        <hr className={divider} />
                        <div>
                            <p className={sectionLabel}>
                                Transactions
                                <span className="ml-1.5 text-[0.68rem] font-normal text-gray-400 normal-case tracking-normal">
                                    {node.transaction_count != null && node.transaction_count > txForNode.length
                                        ? `showing ${txForNode.length.toLocaleString()} of ${node.transaction_count.toLocaleString()}`
                                        : `${txForNode.length.toLocaleString()}`}
                                </span>
                            </p>
                            <div className="flex flex-col gap-0.5 max-h-72 overflow-y-auto pr-1">
                                {txForNode.map((tx) => {
                                    const isSent = tx.from_address === node.address;
                                    const counterparty = isSent ? tx.to_address : tx.from_address;
                                    return (
                                        <button
                                            key={tx.hash}
                                            className="grid grid-cols-[16px_1fr_auto_auto] items-center gap-2 px-[7px] py-[5px] rounded border-none bg-transparent cursor-pointer text-left w-full transition-colors hover:bg-gray-50"
                                            onClick={() => onNavigateToAddress?.(counterparty)}
                                            title={`${isSent ? "Sent to" : "Received from"} ${counterparty}`}
                                        >
                                            <span
                                                className={`font-bold text-[0.85rem] leading-none ${isSent ? "text-orange-500" : "text-green-500"}`}
                                            >
                                                {isSent ? "↑" : "↓"}
                                            </span>
                                            <span
                                                className={`text-[0.72rem] overflow-hidden text-ellipsis whitespace-nowrap ${getNickname(counterparty) ? "text-violet-600 font-medium" : "font-mono text-gray-500"}`}
                                            >
                                                {getNickname(counterparty) ?? formatAddress(counterparty, 4)}
                                            </span>
                                            <span className="text-[0.7rem] font-semibold text-gray-900 whitespace-nowrap">
                                                {formatWei(tx.value)}
                                            </span>
                                            {tx.block_number != null && (
                                                <span className="text-[0.65rem] text-gray-400 whitespace-nowrap">
                                                    #{tx.block_number.toLocaleString()}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            {node.transaction_count != null && node.transaction_count > txForNode.length && (
                                <p className="text-[0.65rem] text-gray-400 mt-1.5 mb-0">
                                    Only the {txForNode.length.toLocaleString()} transactions in the current graph view
                                    are shown. Click <span className="font-semibold">Expand Neighbours</span> or open
                                    the address on Etherscan for the full history.
                                </p>
                            )}
                        </div>
                    </>
                )}

                {/* Properties */}
                {Object.keys(node.properties).length > 0 && (
                    <>
                        <hr className={divider} />
                        <div>
                            <p className={sectionLabel}>Properties</p>
                            <div className="bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-[0.7rem] text-gray-500 overflow-x-auto">
                                <pre className="m-0 font-mono">{JSON.stringify(node.properties, null, 2)}</pre>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </>
    );
}
