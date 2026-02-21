/**
 * Edge (transaction) details panel — Oravia style.
 */
import type { TransactionResponse } from "../types";
import { formatAddress, formatWei } from "../api/client";

interface EdgePanelProps {
    tx: TransactionResponse;
    onClose: () => void;
    onNavigateToAddress?: (address: string) => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="edge-panel-row">
            <span className="edge-panel-row__label">{label}</span>
            <span className="edge-panel-row__value">{value}</span>
        </div>
    );
}

export function EdgePanel({ tx, onClose, onNavigateToAddress }: EdgePanelProps) {
    const extraProps = Object.entries(tx.properties).filter(
        ([k]) => !["value", "block_number", "timestamp", "gas_used", "gas_price"].includes(k),
    );

    return (
        <>
            {/* ── Header ── */}
            <div className="panel-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="panel-section-label" style={{ marginBottom: 4 }}>
                        Transaction
                    </p>
                    <h2 className="heading-md" style={{ marginBottom: 4, fontSize: "0.82rem" }}>
                        {formatAddress(tx.hash, 8)}
                    </h2>
                    <button
                        className="text-mono"
                        style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            color: "var(--text-muted)",
                            fontSize: "0.68rem",
                            textAlign: "left",
                        }}
                        title="Copy hash"
                        onClick={() => navigator.clipboard.writeText(tx.hash)}
                    >
                        Copy hash ↗
                    </button>
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
                {/* Value */}
                <div>
                    <p className="panel-section-label">Value</p>
                    <div className="stat-grid" style={{ gridTemplateColumns: "1fr" }}>
                        <div className="stat-item">
                            <div className="stat-value" style={{ fontSize: "1.1rem", color: "var(--accent-primary)" }}>
                                {formatWei(tx.value)}
                            </div>
                            {tx.value && tx.value !== "0" && (
                                <div className="stat-label">{tx.value} wei</div>
                            )}
                        </div>
                    </div>
                </div>

                <hr className="divider" />

                {/* From / To */}
                <div>
                    <p className="panel-section-label">Flow</p>
                    <div className="edge-panel-flow">
                        <button
                            className="edge-panel-addr edge-panel-addr--from"
                            title={tx.from_address}
                            onClick={() => onNavigateToAddress?.(tx.from_address)}
                        >
                            <span className="edge-panel-addr__dir">FROM</span>
                            <span className="edge-panel-addr__val">{formatAddress(tx.from_address, 5)}</span>
                        </button>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" style={{ flexShrink: 0 }}>
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                        </svg>
                        <button
                            className="edge-panel-addr edge-panel-addr--to"
                            title={tx.to_address}
                            onClick={() => onNavigateToAddress?.(tx.to_address)}
                        >
                            <span className="edge-panel-addr__dir">TO</span>
                            <span className="edge-panel-addr__val">{formatAddress(tx.to_address, 5)}</span>
                        </button>
                    </div>
                </div>

                <hr className="divider" />

                {/* Block / Gas */}
                <div>
                    <p className="panel-section-label">Details</p>
                    <div className="edge-panel-details">
                        {tx.block_number != null && (
                            <Row label="Block" value={`#${tx.block_number.toLocaleString()}`} />
                        )}
                        {tx.timestamp && (
                            <Row label="Timestamp" value={new Date(tx.timestamp).toLocaleString()} />
                        )}
                        {tx.gas_used != null && (
                            <Row label="Gas used" value={tx.gas_used.toLocaleString()} />
                        )}
                        {tx.gas_price && (
                            <Row label="Gas price" value={`${(Number(tx.gas_price) / 1e9).toFixed(2)} Gwei`} />
                        )}
                    </div>
                </div>

                {/* Extra properties */}
                {extraProps.length > 0 && (
                    <>
                        <hr className="divider" />
                        <div>
                            <p className="panel-section-label">Properties</p>
                            <div className="props-block">
                                <pre>{JSON.stringify(Object.fromEntries(extraProps), null, 2)}</pre>
                            </div>
                        </div>
                    </>
                )}

                <hr className="divider" />

                {/* Etherscan link */}
                <div>
                    <p className="panel-section-label">Actions</p>
                    <div className="action-list">
                        <a
                            href={`https://etherscan.io/tx/${tx.hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="action-btn action-btn-secondary"
                        >
                            View on Etherscan
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                        </a>
                    </div>
                </div>
            </div>
        </>
    );
}
