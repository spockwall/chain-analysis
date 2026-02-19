/**
 * React hook for health check monitoring.
 */

import { useState, useEffect, useCallback } from 'react'
import type { HealthResponse } from '../types'
import { checkHealth } from '../api/client'

interface UseHealthState {
  health: HealthResponse | null
  loading: boolean
  error: string | null
  lastChecked: Date | null
}

interface UseHealthOptions {
  /** Auto-refresh interval in milliseconds. Set to 0 to disable. */
  refreshInterval?: number
  /** Whether to fetch immediately on mount */
  fetchOnMount?: boolean
}

export function useHealth(options: UseHealthOptions = {}): UseHealthState & { refresh: () => Promise<void> } {
  const { refreshInterval = 0, fetchOnMount = true } = options

  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await checkHealth()
      setHealth(result)
      setLastChecked(new Date())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Health check failed'
      setError(message)
      setHealth(null)
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
    health,
    loading,
    error,
    lastChecked,
    refresh,
  }
}
