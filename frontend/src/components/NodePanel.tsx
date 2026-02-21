/**
 * Node details panel — Oravia style
 */
import { useState, useEffect } from "react";
import type { EntityResponse, RiskLevel, EntityType, TransactionResponse } from "../types";
import { formatAddress, formatWei, fetchGroupMembers, addGroupMember, removeGroupMember } from "../api/client";
import { useToastContext } from "../context/ToastContext";

interface NodePanelProps {
    node: EntityResponse;
    onExpand: () => void;
    onClose: () => void;
    transactions?: TransactionResponse[];
    onNavigateToAddress?: (address: string) => void;
}

const RISK_BADGE: Record<RiskLevel, string> = {
    unknown: "badge badge-risk-unknown",
    low: "badge badge-risk-low",
    medium: "badge badge-risk-medium",
    high: "badge badge-risk-high",
    critical: "badge badge-risk-critical",
};

const ENTITY_LABEL: Record<EntityType, string> = {
    EOA: "Externally Owned Account",
    Contract: "Smart Contract",
    Mixer: "Mixer",
    LendingPool: "Lending Pool",
    Bridge: "Bridge",
    DEX: "Decentralised Exchange",
    CEXHotWallet: "CEX Hot Wallet",
    Application: "Application",
    Unknown: "Unknown",
};

const RISK_DOT: Record<RiskLevel, string> = {
    unknown: "#94a3b8",
    low: "#22c55e",
    medium: "#eab308",
    high: "#f97316",
    critical: "#ef4444",
};

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
            .then((res) => { if (!cancelled) setMembers(res.members); })
            .catch(() => { /* silently ignore — not all nodes will have members */ })
            .finally(() => { if (!cancelled) setMembersLoading(false); });
        return () => { cancelled = true; };
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
            const msg = err instanceof Error ? err.message : "Failed to add member";
            toast.error(msg);
        }
    };

    const handleRemoveMember = async (childAddress: string) => {
        try {
            await removeGroupMember(node.address, childAddress);
            setMembers((prev) => prev.filter((m) => m.address !== childAddress));
            toast.success(`Removed ${formatAddress(childAddress, 4)}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to remove member";
            toast.error(msg);
        }
    };

    const txForNode = (transactions ?? []).filter(
        (tx) => tx.from_address === node.address || tx.to_address === node.address,
    );

    return (
        <>
            {/* ── Header ── */}
            <div className="panel-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="panel-section-label" style={{ marginBottom: 4 }}>
                        Selected Entity
                    </p>
                    <h2 className="heading-md" style={{ marginBottom: 4 }}>
                        {node.name || "Unknown Entity"}
                    </h2>
                    <p className="text-mono" style={{ color: "var(--text-muted)" }}>
                        {formatAddress(node.address, 8)}
                    </p>
                </div>
                <button className="btn-icon" onClick={onClose} aria-label="Close panel" style={{ flexShrink: 0 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>

            {/* ── Body ── */}
            <div className="panel-body">
                {/* Risk & Type */}
                <div>
                    <p className="panel-section-label">Classification</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        <span className={RISK_BADGE[node.risk_level]}>
                            <span
                                style={{
                                    width: 5,
                                    height: 5,
                                    borderRadius: "50%",
                                    background: RISK_DOT[node.risk_level],
                                    display: "inline-block",
                                }}
                            />
                            {node.risk_level}
                        </span>
                        <span className="badge badge-entity">{ENTITY_LABEL[entityType]}</span>
                    </div>
                </div>

                <hr className="divider" />

                {/* Stats */}
                {(node.transaction_count != null || node.first_seen_block || node.last_seen_block) && (
                    <>
                        <div>
                            <p className="panel-section-label">Activity</p>
                            <div className="stat-grid">
                                {node.transaction_count != null && (
                                    <div className="stat-item">
                                        <div className="stat-value">{node.transaction_count.toLocaleString()}</div>
                                        <div className="stat-label">Transactions</div>
                                    </div>
                                )}
                                {node.first_seen_block && (
                                    <div className="stat-item">
                                        <div className="stat-value" style={{ fontSize: "1rem" }}>
                                            #{node.first_seen_block.toLocaleString()}
                                        </div>
                                        <div className="stat-label">First seen</div>
                                    </div>
                                )}
                                {node.last_seen_block && (
                                    <div className="stat-item">
                                        <div className="stat-value" style={{ fontSize: "1rem" }}>
                                            #{node.last_seen_block.toLocaleString()}
                                        </div>
                                        <div className="stat-label">Last seen</div>
                                    </div>
                                )}
                            </div>
                        </div>
                        <hr className="divider" />
                    </>
                )}

                {/* Labels */}
                {node.labels.length > 0 && (
                    <>
                        <div>
                            <p className="panel-section-label">Labels</p>
                            <div className="tag-list">
                                {node.labels.map((label) => (
                                    <span key={label} className="tag">
                                        {label}
                                    </span>
                                ))}
                            </div>
                        </div>
                        <hr className="divider" />
                    </>
                )}

                {/* Address */}
                <div>
                    <p className="panel-section-label">Address</p>
                    <div className="address-block">
                        <span className="address-text">{node.address}</span>
                        <button
                            className="btn-icon"
                            style={{ width: 26, height: 26 }}
                            title="Copy address"
                            onClick={() => navigator.clipboard.writeText(node.address)}
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                        </button>
                    </div>
                </div>

                <hr className="divider" />

                {/* Actions */}
                <div>
                    <p className="panel-section-label">Actions</p>
                    <div className="action-list">
                        <button className="action-btn action-btn-primary" onClick={onExpand}>
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
                            className="action-btn action-btn-secondary"
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

                {/* Contracts (group members) */}
                <hr className="divider" />
                <div>
                    <p className="panel-section-label">
                        Contracts
                        {members.length > 0 && (
                            <span className="member-count-badge">{members.length}</span>
                        )}
                    </p>
                    {membersLoading ? (
                        <p style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Loading…</p>
                    ) : (
                        <>
                            {members.length > 0 && (
                                <div className="member-list">
                                    {members.map((m) => (
                                        <div key={m.address} className="member-list-item">
                                            <button
                                                className="member-addr-btn"
                                                title={m.address}
                                                onClick={() => onNavigateToAddress?.(m.address)}
                                            >
                                                {formatAddress(m.address, 5)}
                                            </button>
                                            {m.entity_type && (
                                                <span className="badge badge-entity" style={{ fontSize: "0.6rem", padding: "1px 5px" }}>
                                                    {m.entity_type}
                                                </span>
                                            )}
                                            <button
                                                className="btn-icon member-remove-btn"
                                                title="Remove member"
                                                onClick={() => handleRemoveMember(m.address)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="member-add-row">
                                <input
                                    className="member-add-input"
                                    type="text"
                                    placeholder="0x… contract address"
                                    value={memberInput}
                                    onChange={(e) => setMemberInput(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleAddMember(); }}
                                />
                                <button
                                    className="action-btn action-btn-primary"
                                    style={{ flexShrink: 0, padding: "4px 10px", fontSize: "0.7rem" }}
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
                        <hr className="divider" />
                        <div>
                            <p className="panel-section-label">Recent Transactions</p>
                            <div className="tx-list">
                                {txForNode.slice(0, 10).map((tx) => {
                                    const isSent = tx.from_address === node.address;
                                    const counterparty = isSent ? tx.to_address : tx.from_address;
                                    return (
                                        <button
                                            key={tx.hash}
                                            className="tx-list-item"
                                            onClick={() => onNavigateToAddress?.(counterparty)}
                                            title={`${isSent ? "Sent to" : "Received from"} ${counterparty}`}
                                        >
                                            <span className={`tx-dir tx-dir--${isSent ? "sent" : "received"}`}>
                                                {isSent ? "↑" : "↓"}
                                            </span>
                                            <span className="tx-counterparty">{formatAddress(counterparty, 4)}</span>
                                            <span className="tx-value">{formatWei(tx.value)}</span>
                                            {tx.block_number != null && (
                                                <span className="tx-block">#{tx.block_number.toLocaleString()}</span>
                                            )}
                                        </button>
                                    );
                                })}
                                {txForNode.length > 10 && (
                                    <p
                                        style={{
                                            fontSize: "0.65rem",
                                            color: "var(--text-muted)",
                                            textAlign: "center",
                                            margin: "4px 0 0",
                                        }}
                                    >
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
                        <hr className="divider" />
                        <div>
                            <p className="panel-section-label">Properties</p>
                            <div className="props-block">
                                <pre>{JSON.stringify(node.properties, null, 2)}</pre>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </>
    );
}
