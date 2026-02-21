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

const RISK_COLORS: Record<RiskLevel, string> = {
  unknown: '#94a3b8',
  low: '#22c55e',
  medium: '#eab308',
  high: '#f97316',
  critical: '#ef4444',
}

const RISK_BADGE_CLASSES: Record<RiskLevel, string> = {
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
  low: 'bg-green-50 text-green-700 border-green-200',
  medium: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  high: 'bg-orange-50 text-orange-700 border-orange-200',
  critical: 'bg-red-50 text-red-700 border-red-200',
}

const inputCls =
  'w-full px-2.5 py-[7px] border border-gray-200 rounded bg-white text-[0.8rem] text-gray-900 font-[inherit] outline-none transition-all focus:border-indigo-500 focus:shadow-[0_0_0_2px_rgba(99,102,241,0.15)]'

const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-[0.8rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0'

const btnPrimarySm =
  'inline-flex items-center justify-center gap-1.5 px-2.5 py-1 bg-gray-900 text-white text-[0.72rem] font-semibold rounded-lg shadow-sm transition-all hover:-translate-y-px hover:shadow-md disabled:opacity-45 disabled:cursor-not-allowed disabled:translate-y-0'

const btnGhost =
  'inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-transparent text-gray-500 text-[0.8rem] font-medium rounded-lg border border-gray-200 transition-all hover:bg-gray-50'

const btnDangerSm =
  'inline-flex items-center justify-center gap-1.5 px-2.5 py-1 bg-red-50 text-red-500 text-[0.72rem] font-semibold rounded-lg border border-red-200 transition-all hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed'

export function GroupsPage({ onNavigateToExplorer }: GroupsPageProps) {
  const toast = useToastContext()

  const [groups, setGroups] = useState<GroupDetailResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<GroupDetailResponse | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const [editName, setEditName] = useState('')
  const [editRisk, setEditRisk] = useState<RiskLevel>('unknown')
  const [editDesc, setEditDesc] = useState('')
  const [saving, setSaving] = useState(false)

  const [newAddress, setNewAddress] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

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
    <div className="flex h-full overflow-hidden">
      {/* ── Left: group list ── */}
      <div className="w-[260px] shrink-0 border-r border-gray-200 flex flex-col overflow-hidden bg-white">
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-3 border-b border-gray-100 gap-2 shrink-0">
          <span className="text-[0.7rem] font-semibold tracking-widest uppercase text-gray-400">
            {loading ? 'Loading…' : `${groups.length} group${groups.length !== 1 ? 's' : ''}`}
          </span>
          <button
            className={btnPrimarySm}
            onClick={() => { setShowCreateForm(true); setSelected(null) }}
          >
            + New Group
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {groups.map(g => {
            const isActive = selected?.address === g.address && !showCreateForm
            return (
              <button
                key={g.address}
                className={`flex flex-col items-start gap-0.5 w-full px-3.5 py-2.5 border-none border-b border-gray-50 text-left transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-indigo-50/60 border-l-2 border-l-indigo-500 pl-3'
                    : 'bg-transparent hover:bg-gray-50'
                }`}
                onClick={() => handleSelectAddress(g.address)}
              >
                <div className="text-[0.8rem] font-semibold text-gray-900 truncate max-w-[220px]">
                  {g.name ?? formatAddress(g.address)}
                </div>
                <div className="text-[0.68rem] text-gray-400 font-mono">
                  {formatAddress(g.address, 6)}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="inline-flex items-center justify-center bg-indigo-500 text-white rounded-full text-[0.6rem] font-semibold min-w-[16px] h-4 px-1 leading-none">
                    {g.member_count}
                  </span>
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: RISK_COLORS[g.risk_level] }}
                    title={g.risk_level}
                  />
                </div>
              </button>
            )
          })}

          {!loading && groups.length === 0 && (
            <p className="text-[0.8rem] text-gray-400 text-center px-3.5 py-6 m-0">
              No groups yet. Create one to get started.
            </p>
          )}
        </div>
      </div>

      {/* ── Right: detail / create panel ── */}
      <div className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-4">
        {/* Create form */}
        {showCreateForm && (
          <div className="flex flex-col gap-3">
            <h3 className="text-[0.95rem] font-bold text-gray-900 m-0">New Group</h3>
            <div className="flex flex-col gap-1">
              <label className="text-[0.68rem] font-semibold tracking-widest uppercase text-gray-400">Address</label>
              <input
                className={inputCls}
                placeholder="0x…"
                value={newAddress}
                onChange={e => setNewAddress(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[0.68rem] font-semibold tracking-widest uppercase text-gray-400">Name</label>
              <input
                className={inputCls}
                placeholder="Protocol name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
              />
            </div>
            <div className="flex gap-2 items-center">
              <button className={btnPrimary} onClick={handleCreate} disabled={creating}>
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button className={btnGhost} onClick={() => setShowCreateForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Detail view */}
        {selected && !showCreateForm && (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[1.1rem] font-bold text-gray-900">
                  {selected.name ?? formatAddress(selected.address)}
                </div>
                <div className="text-[0.72rem] text-gray-400 font-mono mt-0.5 break-all">
                  {selected.address}
                </div>
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[0.68rem] font-semibold tracking-widest uppercase border whitespace-nowrap ${RISK_BADGE_CLASSES[selected.risk_level]}`}>
                {selected.risk_level}
              </span>
            </div>

            {selected.description && (
              <p className="text-[0.82rem] text-gray-500 m-0 leading-relaxed">{selected.description}</p>
            )}

            <hr className="border-none border-t border-gray-100 m-0" />

            {/* Members */}
            <div>
              <div className="text-[0.65rem] font-semibold tracking-widest uppercase text-gray-400 mb-2">
                Members ({selected.member_count})
              </div>
              <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto mb-1.5">
                {selected.members.map(m => (
                  <div
                    key={m.address}
                    className="flex items-center gap-1.5 px-1 py-0.5 rounded bg-gray-50 border border-gray-100"
                  >
                    <button
                      className="flex-1 text-left bg-none border-none cursor-pointer font-mono text-[0.68rem] text-gray-900 p-0 truncate hover:underline hover:text-indigo-600"
                      onClick={() => onNavigateToExplorer(m.address)}
                      title="Open in Explorer"
                    >
                      {m.name ? `${m.name} (${formatAddress(m.address, 6)})` : formatAddress(m.address)}
                    </button>
                    <button
                      className="shrink-0 flex items-center justify-center w-5 h-5 border-none bg-transparent cursor-pointer text-gray-400 text-base leading-none rounded p-0 transition-colors hover:text-red-500 hover:bg-red-50"
                      onClick={() => handleRemoveMember(m.address)}
                      title="Remove member"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {/* Add member */}
              <div className="flex gap-1.5 items-center mt-1">
                <input
                  className="flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded px-2 py-1 font-mono text-[0.68rem] text-gray-900 outline-none transition-all focus:border-indigo-500 focus:shadow-[0_0_0_2px_rgba(99,102,241,0.15)]"
                  placeholder="0x… add member address"
                  value={memberInput}
                  onChange={e => setMemberInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddMember()}
                />
                <button
                  className={btnPrimarySm}
                  onClick={handleAddMember}
                  disabled={memberLoading || !memberInput.trim()}
                >
                  {memberLoading ? '…' : 'Add'}
                </button>
              </div>
            </div>

            <hr className="border-none border-t border-gray-100 m-0" />

            {/* Edit form */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[0.68rem] font-semibold tracking-widest uppercase text-gray-400">Name</label>
                <input className={inputCls} value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.68rem] font-semibold tracking-widest uppercase text-gray-400">Risk Level</label>
                <select
                  className={inputCls}
                  value={editRisk}
                  onChange={e => setEditRisk(e.target.value as RiskLevel)}
                >
                  {RISK_LEVELS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.68rem] font-semibold tracking-widest uppercase text-gray-400">Description</label>
                <input className={inputCls} value={editDesc} onChange={e => setEditDesc(e.target.value)} />
              </div>
              <div className="flex gap-2 items-center">
                <button className={btnPrimarySm} onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  className={btnDangerSm}
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
          <p className="text-[0.8rem] text-gray-400 text-center m-0 pt-6">
            Select a group or create a new one.
          </p>
        )}
      </div>
    </div>
  )
}
