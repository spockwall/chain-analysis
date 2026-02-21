/**
 * Groups management page — list, create, update, delete group entities.
 */
import { useEffect, useState } from 'react'
import {
  fetchGroups,
  fetchGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
  formatAddress,
} from '../api/client'
import { useToastContext } from '../context/ToastContext'
import type { GroupDetailResponse, RiskLevel } from '../types'

interface GroupsPageProps {
  onNavigateToExplorer: (address: string) => void
}

const RISK_LEVELS: RiskLevel[] = ['unknown', 'low', 'medium', 'high', 'critical']

function riskColor(risk: RiskLevel): string {
  const map: Record<RiskLevel, string> = {
    unknown: 'var(--risk-unknown)',
    low: 'var(--risk-low)',
    medium: 'var(--risk-medium)',
    high: 'var(--risk-high)',
    critical: 'var(--risk-critical)',
  }
  return map[risk] ?? 'var(--risk-unknown)'
}

export function GroupsPage({ onNavigateToExplorer }: GroupsPageProps) {
  const toast = useToastContext()

  const [groups, setGroups] = useState<GroupDetailResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<GroupDetailResponse | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)

  // Edit fields
  const [editName, setEditName] = useState('')
  const [editRisk, setEditRisk] = useState<RiskLevel>('unknown')
  const [editDesc, setEditDesc] = useState('')
  const [saving, setSaving] = useState(false)

  // Create form fields
  const [newAddress, setNewAddress] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // Member management
  const [memberInput, setMemberInput] = useState('')
  const [memberLoading, setMemberLoading] = useState(false)

  async function loadGroups() {
    setLoading(true)
    try {
      const data = await fetchGroups()
      setGroups(data.groups)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load groups')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadGroups()
  }, [])

  function selectGroup(group: GroupDetailResponse) {
    setSelected(group)
    setShowCreateForm(false)
    setEditName(group.name ?? '')
    setEditRisk(group.risk_level)
    setEditDesc((group.properties?.description as string) ?? '')
    setMemberInput('')
  }

  async function handleSelectAddress(address: string) {
    try {
      const detail = await fetchGroup(address)
      selectGroup(detail)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load group')
    }
  }

  async function handleCreate() {
    if (!newAddress.trim() || !newName.trim()) {
      toast.error('Address and name are required')
      return
    }
    setCreating(true)
    try {
      const created = await createGroup({ address: newAddress.trim(), name: newName.trim() })
      toast.success(`Group "${created.name}" created`)
      await loadGroups()
      setShowCreateForm(false)
      setNewAddress('')
      setNewName('')
      setSelected(created)
      setEditName(created.name ?? '')
      setEditRisk(created.risk_level)
      setEditDesc('')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create group')
    } finally {
      setCreating(false)
    }
  }

  async function handleSave() {
    if (!selected) return
    setSaving(true)
    try {
      const updated = await updateGroup(selected.address, {
        name: editName || undefined,
        risk_level: editRisk,
        description: editDesc || undefined,
      })
      toast.success('Group updated')
      setSelected(updated)
      setGroups(prev => prev.map(g => g.address === updated.address ? updated : g))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update group')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!selected) return
    if (selected.member_count > 0) return
    try {
      await deleteGroup(selected.address)
      toast.success('Group deleted')
      setGroups(prev => prev.filter(g => g.address !== selected.address))
      setSelected(null)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete group')
    }
  }

  async function handleAddMember() {
    if (!selected || !memberInput.trim()) return
    setMemberLoading(true)
    try {
      await addGroupMember(selected.address, memberInput.trim())
      toast.success('Member added')
      setMemberInput('')
      const refreshed = await fetchGroup(selected.address)
      setSelected(refreshed)
      setGroups(prev => prev.map(g => g.address === refreshed.address ? refreshed : g))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add member')
    } finally {
      setMemberLoading(false)
    }
  }

  async function handleRemoveMember(childAddress: string) {
    if (!selected) return
    try {
      await removeGroupMember(selected.address, childAddress)
      toast.success('Member removed')
      const refreshed = await fetchGroup(selected.address)
      setSelected(refreshed)
      setGroups(prev => prev.map(g => g.address === refreshed.address ? refreshed : g))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member')
    }
  }

  return (
    <div className="groups-layout">
      {/* ── Left: group list ── */}
      <div className="group-list">
        <div className="group-list-header">
          <span className="group-list-title">
            {loading ? 'Loading…' : `${groups.length} group${groups.length !== 1 ? 's' : ''}`}
          </span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => { setShowCreateForm(true); setSelected(null) }}
          >
            + New Group
          </button>
        </div>

        {groups.map(g => (
          <button
            key={g.address}
            className={`group-list-item${selected?.address === g.address && !showCreateForm ? ' active' : ''}`}
            onClick={() => handleSelectAddress(g.address)}
          >
            <div className="group-list-item-name">{g.name ?? formatAddress(g.address)}</div>
            <div className="group-list-item-addr">{formatAddress(g.address, 6)}</div>
            <div className="group-list-item-meta">
              <span className="member-count-badge">{g.member_count}</span>
              <span
                className="group-risk-dot"
                style={{ background: riskColor(g.risk_level) }}
                title={g.risk_level}
              />
            </div>
          </button>
        ))}

        {!loading && groups.length === 0 && (
          <p className="group-empty-hint">No groups yet. Create one to get started.</p>
        )}
      </div>

      {/* ── Right: detail / create panel ── */}
      <div className="group-detail">
        {showCreateForm && (
          <div className="group-form">
            <h3 className="group-form-heading">New Group</h3>
            <div className="group-form-row">
              <label className="group-form-label">Address</label>
              <input
                className="group-form-input"
                placeholder="0x…"
                value={newAddress}
                onChange={e => setNewAddress(e.target.value)}
              />
            </div>
            <div className="group-form-row">
              <label className="group-form-label">Name</label>
              <input
                className="group-form-input"
                placeholder="Protocol name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
              />
            </div>
            <div className="group-form-actions">
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={creating}
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setShowCreateForm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {selected && !showCreateForm && (
          <>
            {/* Header */}
            <div className="group-detail-header">
              <div>
                <div className="group-detail-name">{selected.name ?? formatAddress(selected.address)}</div>
                <div className="group-detail-addr">{selected.address}</div>
              </div>
              <span
                className="risk-badge"
                style={{ '--risk-color': riskColor(selected.risk_level) } as React.CSSProperties}
              >
                {selected.risk_level}
              </span>
            </div>

            {selected.description && (
              <p className="group-detail-desc">{selected.description}</p>
            )}

            <hr className="group-detail-divider" />

            {/* Members list */}
            <div className="panel-section-label">Members ({selected.member_count})</div>
            <div className="member-list">
              {selected.members.map(m => (
                <div key={m.address} className="member-list-item">
                  <button
                    className="member-addr-btn"
                    onClick={() => onNavigateToExplorer(m.address)}
                    title="Open in Explorer"
                  >
                    {m.name ? `${m.name} (${formatAddress(m.address, 6)})` : formatAddress(m.address)}
                  </button>
                  <button
                    className="member-remove-btn"
                    onClick={() => handleRemoveMember(m.address)}
                    title="Remove member"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Add member */}
            <div className="member-add-row">
              <input
                className="member-add-input"
                placeholder="0x… add member address"
                value={memberInput}
                onChange={e => setMemberInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddMember()}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAddMember}
                disabled={memberLoading || !memberInput.trim()}
              >
                {memberLoading ? '…' : 'Add'}
              </button>
            </div>

            <hr className="group-detail-divider" />

            {/* Edit form */}
            <div className="group-form">
              <div className="group-form-row">
                <label className="group-form-label">Name</label>
                <input
                  className="group-form-input"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                />
              </div>
              <div className="group-form-row">
                <label className="group-form-label">Risk Level</label>
                <select
                  className="group-form-input"
                  value={editRisk}
                  onChange={e => setEditRisk(e.target.value as RiskLevel)}
                >
                  {RISK_LEVELS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="group-form-row">
                <label className="group-form-label">Description</label>
                <input
                  className="group-form-input"
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                />
              </div>
              <div className="group-form-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={handleDelete}
                  disabled={selected.member_count > 0}
                  title={selected.member_count > 0 ? 'Remove all members before deleting' : 'Delete group'}
                >
                  Delete
                </button>
              </div>
            </div>
          </>
        )}

        {!selected && !showCreateForm && (
          <p className="group-empty-hint">Select a group or create a new one.</p>
        )}
      </div>
    </div>
  )
}
