/**
 * React hook for fetching graph statistics.
 */

import { useState, useEffect, useCallback } from 'react'
import type { GraphStatsResponse } from '../types'
import { fetchGraphStats } from '../api/client'

interface UseGraphStatsState {
  stats: GraphStatsResponse | null
  loading: boolean
  error: string | null
  lastFetched: Date | null
}

interface UseGraphStatsOptions {
  /** Auto-refresh interval in milliseconds. Set to 0 to disable. */
  refreshInterval?: number
  /** Whether to fetch immediately on mount */
  fetchOnMount?: boolean
}

export function useGraphStats(options: UseGraphStatsOptions = {}): UseGraphStatsState & { refresh: () => Promise<void> } {
  const { refreshInterval = 0, fetchOnMount = true } = options

  const [stats, setStats] = useState<GraphStatsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await fetchGraphStats()
      setStats(result)
      setLastFetched(new Date())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch graph stats'
      setError(message)
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    if (fetchOnMount) {
      refresh()
    }
  }, [fetchOnMount, refresh])

  // Auto-refresh
  useEffect(() => {
    if (refreshInterval <= 0) return

    const interval = setInterval(refresh, refreshInterval)
    return () => clearInterval(interval)
  }, [refreshInterval, refresh])

  return {
    stats,
    loading,
    error,
    lastFetched,
    refresh,
  }
}
