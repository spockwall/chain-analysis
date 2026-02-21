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

const sectionLabel = "text-[0.65rem] font-semibold tracking-[0.1em] uppercase text-gray-400 mb-2";
const divider = "border-none border-t border-gray-100 m-0";
const btnIcon = "w-[26px] h-[26px] flex items-center justify-center border border-gray-200 rounded bg-transparent cursor-pointer text-gray-500 p-0 transition-colors hover:bg-gray-100 hover:text-gray-900";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex justify-between items-baseline gap-2 text-[0.72rem]">
            <span className="text-gray-400 shrink-0">{label}</span>
            <span className="text-gray-900 font-mono text-right break-all">{value}</span>
        </div>
    );
}

export function EdgePanel({ tx, onClose, onNavigateToAddress }: EdgePanelProps) {
    const extraProps = Object.entries(tx.properties).filter(
        ([k]) => !["value", "block_number", "timestamp", "gas_used", "gas_price"].includes(k),
    );

    return (
        <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
                <div className="flex-1 min-w-0">
                    <p className={`${sectionLabel} mb-1`}>Transaction</p>
                    <h2 className="text-[0.82rem] font-semibold text-gray-900 mb-1">{formatAddress(tx.hash, 8)}</h2>
                    <button
                        className="font-mono text-[0.68rem] text-gray-400 bg-none border-none p-0 cursor-pointer text-left hover:text-gray-600"
                        title="Copy hash"
                        onClick={() => navigator.clipboard.writeText(tx.hash)}
                    >
                        Copy hash ↗
                    </button>
                </div>
                <button className={btnIcon} onClick={onClose} aria-label="Close panel" style={{ flexShrink: 0 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 overflow-y-auto flex-1 flex flex-col gap-5">
                {/* Value */}
                <div>
                    <p className={sectionLabel}>Value</p>
                    <div className="text-[1.1rem] font-bold text-gray-900 leading-none">{formatWei(tx.value)}</div>
                    {tx.value && tx.value !== "0" && (
                        <div className="text-[0.7rem] text-gray-400 mt-[3px]">{tx.value} wei</div>
                    )}
                </div>

                <hr className={divider} />

                {/* Flow */}
                <div>
                    <p className={sectionLabel}>Flow</p>
                    <div className="flex items-center gap-2">
                        <button
                            className="flex-1 flex flex-col gap-0.5 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 cursor-pointer text-left transition-colors hover:border-gray-400"
                            title={tx.from_address}
                            onClick={() => onNavigateToAddress?.(tx.from_address)}
                        >
                            <span className="text-[0.58rem] font-bold tracking-widest uppercase text-gray-500">FROM</span>
                            <span className="font-mono text-[0.7rem] text-gray-900">{formatAddress(tx.from_address, 5)}</span>
                        </button>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" style={{ flexShrink: 0 }}>
                            <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                        </svg>
                        <button
                            className="flex-1 flex flex-col gap-0.5 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 cursor-pointer text-left transition-colors hover:border-gray-400"
                            title={tx.to_address}
                            onClick={() => onNavigateToAddress?.(tx.to_address)}
                        >
                            <span className="text-[0.58rem] font-bold tracking-widest uppercase text-indigo-500">TO</span>
                            <span className="font-mono text-[0.7rem] text-gray-900">{formatAddress(tx.to_address, 5)}</span>
                        </button>
                    </div>
                </div>

                <hr className={divider} />

                {/* Details */}
                <div>
                    <p className={sectionLabel}>Details</p>
                    <div className="flex flex-col gap-1">
                        {tx.block_number != null && <Row label="Block" value={`#${tx.block_number.toLocaleString()}`} />}
                        {tx.timestamp && <Row label="Timestamp" value={new Date(tx.timestamp).toLocaleString()} />}
                        {tx.gas_used != null && <Row label="Gas used" value={tx.gas_used.toLocaleString()} />}
                        {tx.gas_price && <Row label="Gas price" value={`${(Number(tx.gas_price) / 1e9).toFixed(2)} Gwei`} />}
                    </div>
                </div>

                {extraProps.length > 0 && (
                    <>
                        <hr className={divider} />
                        <div>
                            <p className={sectionLabel}>Properties</p>
                            <div className="bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-[0.7rem] text-gray-500 overflow-x-auto">
                                <pre className="m-0 font-mono">{JSON.stringify(Object.fromEntries(extraProps), null, 2)}</pre>
                            </div>
                        </div>
                    </>
                )}

                <hr className={divider} />

                {/* Etherscan */}
                <div>
                    <p className={sectionLabel}>Actions</p>
                    <a
                        href={`https://etherscan.io/tx/${tx.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full px-3.5 py-[9px] rounded-lg text-[0.78rem] font-semibold cursor-pointer flex items-center justify-between transition-colors bg-white text-gray-900 border border-gray-200 no-underline hover:bg-gray-50"
                    >
                        View on Etherscan
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                            <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                    </a>
                </div>
            </div>
        </>
    );
}
