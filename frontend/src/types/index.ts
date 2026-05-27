/**
 * TypeScript types for Chain-Analysis API.
 */

// ── Auth ──────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "operator" | "user";

export interface UserResponse {
    id: number;
    username: string;
    email: string;
    role: UserRole;
    is_active: boolean;
    created_at?: string | null;
    updated_at?: string | null;
}

export interface AuthResponse {
    access_token: string;
    token_type: string;
    user: UserResponse;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface RegisterRequest {
    username: string;
    email: string;
    password: string;
}

export interface AdminUserListResponse {
    users: UserResponse[];
    total: number;
}

export interface AdminUserCreateRequest {
    username: string;
    email: string;
    password: string;
    role: UserRole;
    is_active: boolean;
}

export interface AdminUserUpdateRequest {
    username?: string;
    email?: string;
    password?: string;
    role?: UserRole;
    is_active?: boolean;
}

// ── Entity ────────────────────────────────────────────────────────────────────

export type EntityType =
    | "EOA"
    | "Contract"
    | "Mixer"
    | "LendingPool"
    | "Bridge"
    | "DEX"
    | "CEXHotWallet"
    | "Application"
    | "Unknown";

export type RiskLevel = "unknown" | "low" | "medium" | "high" | "critical";

export interface EntityResponse {
    address: string;
    entity_type?: EntityType | null;
    risk_level: RiskLevel;
    name?: string | null;
    labels: string[];
    first_seen_block?: number | null;
    last_seen_block?: number | null;
    transaction_count?: number | null;
    member_count?: number;
    properties: Record<string, unknown>;
}

export interface GroupMemberEntity extends EntityResponse {
    membership_note?: string | null;
    membership_added_at?: string | null;
}

export interface GroupMemberResponse {
    group_address: string;
    members: GroupMemberEntity[];
    total: number;
}

export interface TransactionResponse {
    hash: string;
    from_address: string;
    to_address: string;
    value?: string | null;
    block_number?: number | null;
    timestamp?: string | null;
    gas_used?: number | null;
    gas_price?: string | null;
    properties: Record<string, unknown>;
}

export interface NeighborsResponse {
    center_address: string;
    nodes: EntityResponse[];
    transactions: TransactionResponse[];
    total_nodes: number;
    total_transactions: number;
}

export interface PathResponse {
    source: string;
    target: string;
    paths: PathData[];
    total_paths: number;
}

export interface PathData {
    nodes: Array<{
        address: string;
        entity_type?: EntityType | null;
        name?: string | null;
    }>;
    transactions: Array<{
        hash: string;
        from_address: string;
        to_address: string;
        value?: string | null;
        block_number?: number | null;
    }>;
    length: number;
    total_value?: string | null;
}

export type DetectionPattern =
    | "peel-chain"
    | "structuring"
    | "round-trip"
    | "fan-out-fan-in"
    | "mixer-interaction";

export interface DetectionsResponse {
    pattern: DetectionPattern;
    address: string;
    matches: number;
    nodes: EntityResponse[];
    transactions: TransactionResponse[];
    highlighted_node_ids: string[];
    highlighted_edge_ids: string[];
    truncated: boolean;
}

export interface HealthResponse {
    status: "healthy" | "degraded";
    services: Record<string, boolean>;
}

// Cytoscape element types
export interface CytoscapeNode {
    data: {
        id: string;
        label: string;
        entityType?: EntityType | null;
        riskLevel: RiskLevel;
        name?: string | null;
    };
}

export interface CytoscapeEdge {
    data: {
        id: string;
        source: string;
        target: string;
        txHash: string;
        value?: string | null;
        blockNumber?: number | null;
    };
}

export type CytoscapeElement = CytoscapeNode | CytoscapeEdge;

// Write request types
export interface NodeUpsertRequest {
    address: string;
    entity_type?: EntityType | null;
    risk_level?: RiskLevel;
    name?: string | null;
    labels?: string[];
    properties?: Record<string, unknown>;
}

// Group management types

export interface GroupCreateRequest {
    name: string;
    entity_type?: string;
    risk_level?: string;
    description?: string;
    properties?: Record<string, unknown>;
}

export interface GroupUpdateRequest {
    name?: string;
    risk_level?: string;
    description?: string;
    properties?: Record<string, unknown>;
}

export interface GroupDetailResponse {
    address: string;
    name: string | null;
    entity_type: string | null;
    risk_level: RiskLevel;
    description: string | null;
    member_count: number;
    members: GroupMemberEntity[];
    properties: Record<string, unknown>;
}

export interface GroupListResponse {
    groups: GroupDetailResponse[];
    total: number;
}

// Graph statistics (for ETL testing)
export interface GraphStatsResponse {
    node_count: number;
    transaction_count: number;
    edge_count: number;
    entity_types: Record<string, number>;
    risk_levels: Record<string, number>;
}

// Ingestion (pipeline)
export interface IngestAddressRequest {
    address: string;
    chain_id?: number;
}

export interface IngestAddressResponse {
    address: string;
    run_id: string;
    status: string;
}

export type IngestionRunStatus = "queued" | "running" | "completed" | "failed";

export interface IngestionRun {
    id: number;
    run_id: string;
    chain_id: number;
    start_block: number;
    end_block: number;
    data_source: string;
    status: IngestionRunStatus;
    error_message: string | null;
    transactions_processed: number;
    traces_processed: number;
    nodes_created: number;
    edges_created: number;
    started_at: string | null;
    completed_at: string | null;
    dagster_run_id: string | null;
}

// ── Labeling ──────────────────────────────────────────────────────────────────

export type LabelTaskStatus =
    | "pending"
    | "running"
    | "completed"
    | "cancelled";

export interface LabelTaskResponse {
    id: number;
    entity_address: string;
    status: LabelTaskStatus;
    priority: number;
    title: string | null;
    description: string | null;
    assignee_id: number | null;
    created_at: string;
    updated_at: string;
}

export interface LabelFetchRequest {
    mode: "addresses" | "hashes" | "neighborhood";
    addresses?: string[];
    hashes?: string[];
    seed?: string;
    hops?: number;
}

export interface LabelFetchResponse {
    task_ids: number[];
    queued: number;
}

export interface AnnotationCreateRequest {
    task_id: number;
    entity_address: string;
    entity_type?: EntityType | null;
    risk_level: RiskLevel;
    labels?: string[];
    notes?: string | null;
    evidence?: string | null;
    confidence?: number | null;
}

export interface AnnotationResponse {
    id: number;
    task_id: number;
    user_id: number | null;
    entity_address: string;
    entity_type: EntityType | null;
    risk_level: RiskLevel;
    labels: string[];
    notes: string | null;
    confidence: number | null;
    created_at: string;
}
