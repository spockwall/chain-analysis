/**
 * API client for Chain-Analysis backend.
 */

import type {
    AuthResponse,
    EntityResponse,
    GroupCreateRequest,
    GroupDetailResponse,
    GroupListResponse,
    GroupMemberResponse,
    GroupUpdateRequest,
    LoginRequest,
    NeighborsResponse,
    NodeUpsertRequest,
    PathResponse,
    RegisterRequest,
    TransactionResponse,
    HealthResponse,
    GraphStatsResponse,
    UserResponse,
} from "../types";

const API_BASE = "/api";

const TOKEN_KEY = "ca_access_token";

export function getStoredToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
    localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

async function request<T>(endpoint: string, options: RequestInit = {}, noContent = false): Promise<T> {
    const url = `${API_BASE}${endpoint}`;
    const token = getStoredToken();

    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...options.headers,
        },
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new ApiError(errorData.detail || `HTTP ${response.status}`, response.status);
    }

    if (noContent) return undefined as T;
    return response.json();
}

// Auth endpoints

export async function login(body: LoginRequest): Promise<AuthResponse> {
    return request<AuthResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export async function register(body: RegisterRequest): Promise<AuthResponse> {
    return request<AuthResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export async function fetchMe(): Promise<UserResponse> {
    return request<UserResponse>("/auth/me");
}

// Entity endpoints

export async function fetchEntity(address: string): Promise<EntityResponse> {
    return request<EntityResponse>(`/entities/${address}`);
}

export interface NeighborsOptions {
    depth?: number;
    direction?: "in" | "out" | "both";
    limit?: number;
}

export async function fetchNeighbors(address: string, options: NeighborsOptions = {}): Promise<NeighborsResponse> {
    const params = new URLSearchParams();

    if (options.depth !== undefined) {
        params.set("depth", options.depth.toString());
    }
    if (options.direction) {
        params.set("direction", options.direction);
    }
    if (options.limit !== undefined) {
        params.set("limit", options.limit.toString());
    }

    const query = params.toString();
    const endpoint = `/entities/${address}/neighbors${query ? `?${query}` : ""}`;

    return request<NeighborsResponse>(endpoint);
}

export interface PathOptions {
    maxDepth?: number;
    limit?: number;
}

export async function fetchPaths(source: string, target: string, options: PathOptions = {}): Promise<PathResponse> {
    const params = new URLSearchParams();

    if (options.maxDepth !== undefined) {
        params.set("max_depth", options.maxDepth.toString());
    }
    if (options.limit !== undefined) {
        params.set("limit", options.limit.toString());
    }

    const query = params.toString();
    const endpoint = `/entities/${source}/paths/${target}${query ? `?${query}` : ""}`;

    return request<PathResponse>(endpoint);
}

// Transaction endpoints

export async function fetchTransaction(hash: string): Promise<TransactionResponse> {
    return request<TransactionResponse>(`/transactions/${hash}`);
}

export interface TransactionUpsertRequest {
    from_address: string;
    to_address: string;
    value?: string;
    block_number?: number;
    timestamp?: string;
    gas_used?: number;
    gas_price?: string;
    properties?: Record<string, unknown>;
}

export async function upsertTransaction(hash: string, body: TransactionUpsertRequest): Promise<TransactionResponse> {
    return request<TransactionResponse>(`/transactions/${hash}`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

export async function deleteTransaction(hash: string): Promise<void> {
    return request<void>(`/transactions/${hash}`, { method: "DELETE" }, true);
}

// Health endpoints

export async function checkHealth(): Promise<HealthResponse> {
    const response = await fetch("/health");
    if (!response.ok) {
        throw new ApiError("Health check failed", response.status);
    }
    return response.json();
}

// Node mutation endpoints

export async function upsertEntity(address: string, body: NodeUpsertRequest): Promise<EntityResponse> {
    return request<EntityResponse>(`/entities/${address}`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

export async function updateEntity(address: string, body: NodeUpsertRequest): Promise<EntityResponse> {
    return request<EntityResponse>(`/entities/${address}`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
}

export async function deleteEntity(address: string): Promise<void> {
    return request<void>(`/entities/${address}`, { method: "DELETE" }, true);
}

// Group member endpoints

export async function fetchGroupMembers(address: string): Promise<GroupMemberResponse> {
    return request<GroupMemberResponse>(`/entities/${address}/members`);
}

export async function addGroupMember(address: string, childAddress: string): Promise<GroupMemberResponse> {
    return request<GroupMemberResponse>(`/entities/${address}/members`, {
        method: "POST",
        body: JSON.stringify({ member_address: childAddress }),
    });
}

export async function removeGroupMember(address: string, memberAddress: string): Promise<void> {
    return request<void>(`/entities/${address}/members/${memberAddress}`, { method: "DELETE" }, true);
}

// Group endpoints

export async function fetchGroups(): Promise<GroupListResponse> {
    return request<GroupListResponse>("/groups");
}

export async function fetchGroup(address: string): Promise<GroupDetailResponse> {
    return request<GroupDetailResponse>(`/groups/${address}`);
}

export async function createGroup(body: GroupCreateRequest): Promise<GroupDetailResponse> {
    return request<GroupDetailResponse>("/groups", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export async function updateGroup(address: string, body: GroupUpdateRequest): Promise<GroupDetailResponse> {
    return request<GroupDetailResponse>(`/groups/${address}`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
}

export async function deleteGroup(address: string): Promise<void> {
    return request<void>(`/groups/${address}`, { method: "DELETE" }, true);
}

// Graph stats endpoints (for ETL testing)

export async function fetchGraphStats(): Promise<GraphStatsResponse> {
    return request<GraphStatsResponse>("/stats");
}

// Utility functions

export function formatAddress(address: string, length = 8): string {
    if (address.length <= length * 2 + 2) {
        return address;
    }
    return `${address.slice(0, length + 2)}...${address.slice(-length)}`;
}

export function formatWei(wei: string | null | undefined): string {
    if (!wei) return "0";

    // Values are stored as wei integers (e.g. "10000000000000000000" = 10 ETH)
    // Use BigInt for parsing to avoid precision loss on large integers,
    // then convert to ETH float for display.
    let weiInt: bigint;
    try {
        weiInt = BigInt(wei);
    } catch {
        // Not a valid integer (e.g. already an ETH float) — display as-is
        return `${Number(wei).toFixed(4)} ETH`;
    }

    if (weiInt === 0n) return "0 ETH";

    const eth = Number(weiInt) / 1e18;
    if (eth < 0.001) return "< 0.001 ETH";
    if (eth < 1) return `${eth.toFixed(4)} ETH`;
    if (eth < 1000) return `${eth.toFixed(2)} ETH`;
    return `${(eth / 1000).toFixed(2)}K ETH`;
}
