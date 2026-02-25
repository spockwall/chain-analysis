/**
 * Node details panel — Oravia style
 */
import { useState, useEffect } from "react";
import type { EntityResponse, TransactionResponse } from "../types";
import { formatAddress, formatWei, fetchGroupMembers, addGroupMember, removeGroupMember } from "../api/client";
import { useToastContext } from "../context/ToastContext";
import { RISK_BADGE, ENTITY_LABEL, sectionLabel, labelCls } from "../constants";
import { CopyButton } from "./CopyButton";

interface NodePanelProps {
    node: EntityResponse;
    onExpand: () => void;
    onClose: () => void;
    transactions?: TransactionResponse[];
    onNavigateToAddress?: (address: string) => void;
}

const divider = "border-none border-t border-gray-100 m-0";
const btnIcon =
    "w-[26px] h-[26px] flex items-center justify-center border border-gray-200 rounded bg-transparent cursor-pointer text-gray-500 p-0 transition-colors hover:bg-gray-100 hover:text-gray-900";

export function NodePanel({ node, onExpand, onClose, transactions, onNavigateToAddress }: NodePanelProps) {
    const entityType = node.entity_type || "Unknown";
    const toast = useToastContext();

    const [members, setMembers] = useState<EntityResponse[]>([]);
    const [memberInput, setMemberInput] = useState("");
    const [membersLoading, setMembersLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
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
    }, [node.address]);

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

    const txForNode = (transactions ?? []).filter(
        (tx) => tx.from_address === node.address || tx.to_address === node.address,
    );

    return (
        <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
                <div className="flex-1 min-w-0">
                    <p className={`${sectionLabel} mb-1`}>Selected Entity</p>
                    <h2 className="text-[1.25rem] font-semibold tracking-[-0.01em] text-gray-900 mb-1">
                        {node.name || "Unknown Entity"}
                    </h2>
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

                {/* Group members */}
                <hr className={divider} />
                <div>
                    <p className={sectionLabel}>
                        Contracts
                        {members.length > 0 && (
                            <span className="inline-flex items-center justify-center bg-indigo-500 text-white rounded-full text-[0.6rem] font-semibold min-w-[16px] h-4 px-1 leading-none ml-1.5 align-middle">
                                {members.length}
                            </span>
                        )}
                    </p>
                    {membersLoading ? (
                        <p className="text-[0.7rem] text-gray-400">Loading…</p>
                    ) : (
                        <>
                            {members.length > 0 && (
                                <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto mb-1.5">
                                    {members.map((m) => (
                                        <div
                                            key={m.address}
                                            className="flex items-center gap-1.5 px-1 py-[3px] rounded bg-gray-50 border border-gray-100"
                                        >
                                            <button
                                                className="flex-1 text-left bg-none border-none cursor-pointer font-mono text-[0.68rem] text-gray-900 p-0 truncate hover:underline"
                                                title={m.address}
                                                onClick={() => onNavigateToAddress?.(m.address)}
                                            >
                                                {formatAddress(m.address, 5)}
                                            </button>
                                            {m.entity_type && (
                                                <span className="inline-flex items-center px-[5px] py-[1px] rounded text-[0.6rem] font-semibold uppercase bg-violet-50 text-violet-700">
                                                    {m.entity_type}
                                                </span>
                                            )}
                                            <button
                                                className="shrink-0 flex items-center justify-center w-5 h-5 border border-gray-200 rounded bg-transparent cursor-pointer text-gray-400 text-base leading-none p-0 transition-colors hover:text-red-500 hover:bg-red-50"
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
                                    className="flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded px-2 py-1 font-mono text-[0.68rem] text-gray-900 outline-none focus:border-indigo-400"
                                    type="text"
                                    placeholder="0x… contract address"
                                    value={memberInput}
                                    onChange={(e) => setMemberInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleAddMember();
                                    }}
                                />
                                <button
                                    className="shrink-0 px-2.5 py-1 bg-gray-900 text-white text-[0.7rem] font-semibold rounded border-none cursor-pointer transition-colors hover:bg-[#1e293b]"
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
                            <p className={sectionLabel}>Recent Transactions</p>
                            <div className="flex flex-col gap-0.5">
                                {txForNode.slice(0, 10).map((tx) => {
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
                                            <span className="text-[0.72rem] font-mono text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
                                                {formatAddress(counterparty, 4)}
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
                                {txForNode.length > 10 && (
                                    <p className="text-[0.65rem] text-gray-400 text-center mt-1 mb-0">
                                        +{txForNode.length - 10} more
                                    </p>
                                )}
                            </div>
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
