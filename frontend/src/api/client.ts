/**
 * API client for Chain-Analysis backend.
 */

import type {
  EntityResponse,
  EdgeResponse,
  EdgeUpsertRequest,
  GroupMemberResponse,
  NeighborsResponse,
  NodeUpsertRequest,
  PathResponse,
  TransactionResponse,
  HealthResponse,
  GraphStatsResponse,
} from '../types'

const API_BASE = '/api'

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new ApiError(
      errorData.detail || `HTTP ${response.status}`,
      response.status
    )
  }

  return response.json()
}

// Entity endpoints

export async function fetchEntity(address: string): Promise<EntityResponse> {
  return request<EntityResponse>(`/entities/${address}`)
}

export interface NeighborsOptions {
  depth?: number
  direction?: 'in' | 'out' | 'both'
  edgeTypes?: string[]
  limit?: number
}

export async function fetchNeighbors(
  address: string,
  options: NeighborsOptions = {}
): Promise<NeighborsResponse> {
  const params = new URLSearchParams()

  if (options.depth !== undefined) {
    params.set('depth', options.depth.toString())
  }
  if (options.direction) {
    params.set('direction', options.direction)
  }
  if (options.edgeTypes?.length) {
    options.edgeTypes.forEach(t => params.append('edge_types', t))
  }
  if (options.limit !== undefined) {
    params.set('limit', options.limit.toString())
  }

  const query = params.toString()
  const endpoint = `/entities/${address}/neighbors${query ? `?${query}` : ''}`

  return request<NeighborsResponse>(endpoint)
}

export interface PathOptions {
  maxDepth?: number
  edgeTypes?: string[]
  limit?: number
}

export async function fetchPaths(
  source: string,
  target: string,
  options: PathOptions = {}
): Promise<PathResponse> {
  const params = new URLSearchParams()

  if (options.maxDepth !== undefined) {
    params.set('max_depth', options.maxDepth.toString())
  }
  if (options.edgeTypes?.length) {
    options.edgeTypes.forEach(t => params.append('edge_types', t))
  }
  if (options.limit !== undefined) {
    params.set('limit', options.limit.toString())
  }

  const query = params.toString()
  const endpoint = `/entities/${source}/paths/${target}${query ? `?${query}` : ''}`

  return request<PathResponse>(endpoint)
}

// Transaction endpoints

export async function fetchTransaction(hash: string): Promise<TransactionResponse> {
  return request<TransactionResponse>(`/transactions/${hash}`)
}

// Health endpoints

export async function checkHealth(): Promise<HealthResponse> {
  const response = await fetch('/health')
  if (!response.ok) {
    throw new ApiError('Health check failed', response.status)
  }
  return response.json()
}

// Node / edge mutation endpoints

export async function upsertEntity(
  address: string,
  body: NodeUpsertRequest
): Promise<EntityResponse> {
  return request<EntityResponse>(`/entities/${address}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function updateEntity(
  address: string,
  body: NodeUpsertRequest
): Promise<EntityResponse> {
  return request<EntityResponse>(`/entities/${address}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteEntity(address: string): Promise<void> {
  const url = `${API_BASE}/entities/${address}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new ApiError(errorData.detail || `HTTP ${response.status}`, response.status)
  }
}

export async function upsertEdge(
  source: string,
  target: string,
  body: EdgeUpsertRequest
): Promise<EdgeResponse> {
  return request<EdgeResponse>(`/entities/${source}/edges/${target}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteEdge(
  source: string,
  target: string,
  edgeType = 'TRANSFER'
): Promise<void> {
  const url = `${API_BASE}/entities/${source}/edges/${target}?edge_type=${encodeURIComponent(edgeType)}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new ApiError(errorData.detail || `HTTP ${response.status}`, response.status)
  }
}

// Group member endpoints

export async function fetchGroupMembers(address: string): Promise<GroupMemberResponse> {
  return request<GroupMemberResponse>(`/entities/${address}/members`)
}

export async function addGroupMember(
  address: string,
  childAddress: string
): Promise<GroupMemberResponse> {
  return request<GroupMemberResponse>(`/entities/${address}/members`, {
    method: 'POST',
    body: JSON.stringify({ child_address: childAddress }),
  })
}

export async function removeGroupMember(address: string, childAddress: string): Promise<void> {
  const url = `${API_BASE}/entities/${address}/members/${childAddress}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new ApiError(errorData.detail || `HTTP ${response.status}`, response.status)
  }
}

// Graph stats endpoints (for ETL testing)

export async function fetchGraphStats(): Promise<GraphStatsResponse> {
  return request<GraphStatsResponse>('/stats')
}

// Utility functions

export function formatAddress(address: string, length = 8): string {
  if (address.length <= length * 2 + 2) {
    return address
  }
  return `${address.slice(0, length + 2)}...${address.slice(-length)}`
}

export function formatWei(wei: string | null | undefined): string {
  if (!wei) return '0'

  // Convert wei to ETH (divide by 10^18)
  const weiNum = BigInt(wei)
  const eth = Number(weiNum) / 1e18

  if (eth < 0.001) {
    return '< 0.001 ETH'
  }
  if (eth < 1) {
    return `${eth.toFixed(4)} ETH`
  }
  if (eth < 1000) {
    return `${eth.toFixed(2)} ETH`
  }
  return `${(eth / 1000).toFixed(2)}K ETH`
}
