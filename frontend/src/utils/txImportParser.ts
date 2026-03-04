/**
 * txImportParser.ts
 *
 * Parses a .json or .csv file into a list of validated transaction rows
 * ready for submission to the upsertTransaction API.
 *
 * Supported JSON shapes:
 *   - Array of objects:  [{hash, from_address, to_address, ...}, ...]
 *   - Single object:     {hash, from_address, to_address, ...}
 *
 * Supported CSV format:
 *   - Row 1: header (case-insensitive, snake_case or camelCase accepted)
 *   - Required columns: hash, from_address (or fromAddress), to_address (or toAddress)
 *   - Optional columns: value, block_number (or blockNumber), timestamp,
 *                       gas_used (or gasUsed), gas_price (or gasPrice)
 *
 * Value field rules:
 *   - If the value looks like a large integer (> 1e15) it is treated as wei.
 *   - Otherwise it is treated as ETH and converted to wei.
 *   - Empty / missing → omitted from the request body.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedTxRow {
    /** Original row index (0-based) */
    index: number;
    hash: string;
    from_address: string;
    to_address: string;
    value?: string;         // wei string
    block_number?: number;
    timestamp?: string;
    gas_used?: number;
    gas_price?: string;
    /** true when all required fields are valid */
    valid: boolean;
    errors: string[];
}

// ── Validation helpers ────────────────────────────────────────────────────────

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function validateRow(raw: Record<string, string | undefined>): ParsedTxRow {
    const errors: string[] = [];
    const index = raw._index !== undefined ? Number(raw._index) : 0;

    // ── hash ─────────────────────────────────────────────────────────────────
    const hash = (raw.hash ?? raw.txHash ?? raw.tx_hash ?? "").trim();
    if (!hash) errors.push("Missing hash");
    else if (!TX_HASH_RE.test(hash)) errors.push(`Invalid hash: must be 0x + 64 hex chars`);

    // ── addresses ────────────────────────────────────────────────────────────
    const from_address = (
        raw.from_address ?? raw.fromAddress ?? raw.from ?? ""
    ).trim().toLowerCase();
    if (!from_address) errors.push("Missing from_address");
    else if (!ADDRESS_RE.test(from_address)) errors.push("Invalid from_address");

    const to_address = (
        raw.to_address ?? raw.toAddress ?? raw.to ?? ""
    ).trim().toLowerCase();
    if (!to_address) errors.push("Missing to_address");
    else if (!ADDRESS_RE.test(to_address)) errors.push("Invalid to_address");

    // ── value ─────────────────────────────────────────────────────────────────
    let value: string | undefined;
    const rawValue = (raw.value ?? raw.amount ?? "").trim();
    if (rawValue) {
        try {
            const n = Number(rawValue);
            if (isNaN(n) || n < 0) {
                errors.push("Invalid value: must be a non-negative number");
            } else if (n > 1e15) {
                // Already looks like wei
                value = BigInt(rawValue).toString();
            } else {
                // Treat as ETH → convert to wei
                value = BigInt(Math.round(n * 1e18)).toString();
            }
        } catch {
            errors.push("Invalid value: could not parse");
        }
    }

    // ── block_number ─────────────────────────────────────────────────────────
    let block_number: number | undefined;
    const rawBlock = (raw.block_number ?? raw.blockNumber ?? raw.block ?? "").trim();
    if (rawBlock) {
        const n = parseInt(rawBlock, 10);
        if (isNaN(n) || n < 0) errors.push("Invalid block_number");
        else block_number = n;
    }

    // ── timestamp ────────────────────────────────────────────────────────────
    const timestamp = (raw.timestamp ?? "").trim() || undefined;

    // ── gas_used ─────────────────────────────────────────────────────────────
    let gas_used: number | undefined;
    const rawGasUsed = (raw.gas_used ?? raw.gasUsed ?? "").trim();
    if (rawGasUsed) {
        const n = parseInt(rawGasUsed, 10);
        if (!isNaN(n) && n >= 0) gas_used = n;
    }

    // ── gas_price ────────────────────────────────────────────────────────────
    const gas_price = (raw.gas_price ?? raw.gasPrice ?? "").trim() || undefined;

    return {
        index,
        hash,
        from_address,
        to_address,
        ...(value !== undefined && { value }),
        ...(block_number !== undefined && { block_number }),
        ...(timestamp && { timestamp }),
        ...(gas_used !== undefined && { gas_used }),
        ...(gas_price && { gas_price }),
        valid: errors.length === 0,
        errors,
    };
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text: string): ParsedTxRow[] {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    if (lines.length < 2) return [];

    // Header normalisation: lowercase, strip quotes
    const headers = lines[0]
        .split(",")
        .map((h) => h.trim().replace(/^["']|["']$/g, "").toLowerCase());

    return lines.slice(1).map((line, idx) => {
        // Simple CSV split — handles quoted fields with commas
        const values = splitCSVLine(line);
        const raw: Record<string, string | undefined> = { _index: String(idx) };
        headers.forEach((h, i) => {
            raw[h] = values[i] !== undefined ? values[i].replace(/^["']|["']$/g, "").trim() : undefined;
        });
        return validateRow(raw);
    });
}

/** Splits a single CSV line, respecting double-quoted fields. */
function splitCSVLine(line: string): string[] {
    const result: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
            else inQuote = !inQuote;
        } else if (ch === "," && !inQuote) {
            result.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    result.push(cur);
    return result;
}

// ── JSON parser ───────────────────────────────────────────────────────────────

function parseJSON(text: string): ParsedTxRow[] {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON: could not parse file");
    }

    const rows: unknown[] = Array.isArray(data) ? data : [data];
    return rows.map((row, idx) => {
        if (typeof row !== "object" || row === null) {
            return { index: idx, hash: "", from_address: "", to_address: "", valid: false, errors: ["Row is not an object"] };
        }
        const raw = row as Record<string, unknown>;
        const stringified: Record<string, string | undefined> = { _index: String(idx) };
        for (const [k, v] of Object.entries(raw)) {
            stringified[k] = v !== undefined && v !== null ? String(v) : undefined;
        }
        return validateRow(stringified);
    });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Reads a File and returns parsed, validated transaction rows.
 * Detects format from the file extension (.csv) or first non-whitespace
 * character ('[' or '{' → JSON, otherwise CSV).
 */
export async function parseTxImportFile(file: File): Promise<ParsedTxRow[]> {
    const text = await file.text();
    const trimmed = text.trimStart();

    const isJSON =
        file.name.toLowerCase().endsWith(".json") ||
        trimmed.startsWith("[") ||
        trimmed.startsWith("{");

    return isJSON ? parseJSON(text) : parseCSV(text);
}
