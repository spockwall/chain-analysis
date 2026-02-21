/**
 * TypeScript types for Chain-Analysis API.
 */

export type EntityType =
  | 'EOA'
  | 'Contract'
  | 'Mixer'
  | 'LendingPool'
  | 'Bridge'
  | 'DEX'
  | 'CEXHotWallet'
  | 'Application'
  | 'Unknown'

export type RiskLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical'

export interface EntityResponse {
  address: string
  entity_type?: EntityType | null
  risk_level: RiskLevel
  name?: string | null
  labels: string[]
  first_seen_block?: number | null
  last_seen_block?: number | null
  transaction_count?: number | null
  member_count?: number
  properties: Record<string, unknown>
}

export interface GroupMemberResponse {
  parent_address: string
  members: EntityResponse[]
  total: number
}

export interface EdgeResponse {
  source: string
  target: string
  edge_type: string
  value?: string | null
  block_number?: number | null
  timestamp?: string | null
  tx_hash?: string | null
  properties: Record<string, unknown>
}

export interface TransactionResponse {
  hash: string
  from_address: string
  to_address: string
  value?: string | null
  block_number?: number | null
  timestamp?: string | null
  gas_used?: number | null
  gas_price?: string | null
  properties: Record<string, unknown>
}

export interface NeighborsResponse {
  center_address: string
  nodes: EntityResponse[]
  transactions: TransactionResponse[]
  total_nodes: number
  total_transactions: number
}

export interface PathResponse {
  source: string
  target: string
  paths: PathData[]
  total_paths: number
}

export interface PathData {
  nodes: Array<{
    address: string
    entity_type?: EntityType | null
    name?: string | null
  }>
  transactions: Array<{
    hash: string
    from_address: string
    to_address: string
    value?: string | null
    block_number?: number | null
  }>
  length: number
  total_value?: string | null
}

export interface HealthResponse {
  status: 'healthy' | 'degraded'
  services: Record<string, boolean>
}

// Cytoscape element types
export interface CytoscapeNode {
  data: {
    id: string
    label: string
    entityType?: EntityType | null
    riskLevel: RiskLevel
    name?: string | null
  }
}

export interface CytoscapeEdge {
  data: {
    id: string
    source: string
    target: string
    txHash: string
    value?: string | null
    blockNumber?: number | null
  }
}

export type CytoscapeElement = CytoscapeNode | CytoscapeEdge

// Write request types
export interface NodeUpsertRequest {
  address: string
  entity_type?: EntityType | null
  risk_level?: RiskLevel
  name?: string | null
  labels?: string[]
  properties?: Record<string, unknown>
}

export interface EdgeUpsertRequest {
  source: string
  target: string
  edge_type?: string
  value?: string | null
  tx_hash?: string | null
  block_number?: number | null
  properties?: Record<string, unknown>
}

// Group management types

export interface GroupCreateRequest {
  address: string
  name: string
  entity_type?: string
  risk_level?: string
  description?: string
  properties?: Record<string, unknown>
}

export interface GroupUpdateRequest {
  name?: string
  risk_level?: string
  description?: string
  properties?: Record<string, unknown>
}

export interface GroupDetailResponse {
  address: string
  name: string | null
  entity_type: string | null
  risk_level: RiskLevel
  description: string | null
  member_count: number
  members: EntityResponse[]
  properties: Record<string, unknown>
}

export interface GroupListResponse {
  groups: GroupDetailResponse[]
  total: number
}

// Graph statistics (for ETL testing)
export interface GraphStatsResponse {
  node_count: number
  transaction_count: number
  edge_count: number
  entity_types: Record<string, number>
  risk_levels: Record<string, number>
}
