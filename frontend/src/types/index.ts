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
  properties: Record<string, unknown>
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

export interface NeighborsResponse {
  center_address: string
  nodes: EntityResponse[]
  edges: EdgeResponse[]
  total_nodes: number
  total_edges: number
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
  edges: Array<{
    source: string
    target: string
    edge_type: string
    value?: string | null
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
    edgeType: string
    value?: string | null
  }
}

export type CytoscapeElement = CytoscapeNode | CytoscapeEdge
