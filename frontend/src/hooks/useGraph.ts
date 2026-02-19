/**
 * React hook for graph data management.
 */

import { useState, useCallback } from 'react'
import type { EntityResponse, NeighborsResponse, PathResponse } from '../types'
import { fetchEntity, fetchNeighbors, fetchPaths, NeighborsOptions, PathOptions } from '../api/client'

interface UseGraphState {
  graphData: NeighborsResponse | null
  selectedNode: EntityResponse | null
  loading: boolean
  error: string | null
}

interface UseGraphActions {
  loadEntity: (address: string) => Promise<void>
  expandNode: (address: string, options?: NeighborsOptions) => Promise<void>
  findPaths: (source: string, target: string, options?: PathOptions) => Promise<PathResponse | null>
  selectNode: (address: string) => Promise<void>
  clearSelection: () => void
  clearGraph: () => void
}

export function useGraph(): UseGraphState & UseGraphActions {
  const [graphData, setGraphData] = useState<NeighborsResponse | null>(null)
  const [selectedNode, setSelectedNode] = useState<EntityResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadEntity = useCallback(async (address: string) => {
    setLoading(true)
    setError(null)

    try {
      const [entity, neighbors] = await Promise.all([
        fetchEntity(address),
        fetchNeighbors(address, { depth: 1, limit: 50 }),
      ])

      setSelectedNode(entity)
      setGraphData(neighbors)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load entity'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  const expandNode = useCallback(async (address: string, options: NeighborsOptions = {}) => {
    setLoading(true)
    setError(null)

    try {
      const neighbors = await fetchNeighbors(address, {
        depth: 1,
        limit: 50,
        ...options,
      })

      setGraphData(prevData => {
        if (!prevData) {
          return neighbors
        }

        // Merge with existing data
        const existingAddresses = new Set(prevData.nodes.map(n => n.address))
        const newNodes = neighbors.nodes.filter(n => !existingAddresses.has(n.address))

        const existingEdges = new Set(
          prevData.edges.map(e => `${e.source}-${e.target}-${e.edge_type}`)
        )
        const newEdges = neighbors.edges.filter(
          e => !existingEdges.has(`${e.source}-${e.target}-${e.edge_type}`)
        )

        return {
          ...prevData,
          center_address: address,
          nodes: [...prevData.nodes, ...newNodes],
          edges: [...prevData.edges, ...newEdges],
          total_nodes: prevData.nodes.length + newNodes.length,
          total_edges: prevData.edges.length + newEdges.length,
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to expand node'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  const findPaths = useCallback(async (
    source: string,
    target: string,
    options: PathOptions = {}
  ): Promise<PathResponse | null> => {
    setLoading(true)
    setError(null)

    try {
      const paths = await fetchPaths(source, target, options)
      return paths
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to find paths'
      setError(message)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const selectNode = useCallback(async (address: string) => {
    setLoading(true)
    setError(null)

    try {
      const entity = await fetchEntity(address)
      setSelectedNode(entity)
    } catch {
      // Node might not have full details
      setSelectedNode({
        address,
        risk_level: 'unknown',
        labels: [],
        properties: {},
      })
    } finally {
      setLoading(false)
    }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedNode(null)
  }, [])

  const clearGraph = useCallback(() => {
    setGraphData(null)
    setSelectedNode(null)
    setError(null)
  }, [])

  return {
    graphData,
    selectedNode,
    loading,
    error,
    loadEntity,
    expandNode,
    findPaths,
    selectNode,
    clearSelection,
    clearGraph,
  }
}
