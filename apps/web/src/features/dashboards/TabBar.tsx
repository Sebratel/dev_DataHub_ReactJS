// Barra de abas (guias) de um dashboard — no estilo do dashboards_IA. Fora do
// modo de edição é só navegação; em edição permite renomear (duplo-clique),
// excluir e adicionar abas. O dashboard nunca fica sem aba.
import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import clsx from 'clsx'
import type { DashboardTab } from '@datahub/shared'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'

interface Props {
  dashboardId: string
  tabs: DashboardTab[]
  activeTabId: string
  editMode: boolean
  onSwitch: (id: string) => void
  onChanged: (opts?: { switchTo?: string }) => void
}

export default function TabBar({ dashboardId, tabs, activeTabId, editMode, onSwitch, onChanged }: Props) {
  const confirm = useConfirm()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  async function rename(tabId: string) {
    const label = draft.trim()
    setEditingId(null)
    if (!label) return
    await api(`/api/v1/dashboards/${dashboardId}/tabs/${tabId}`, { method: 'PATCH', body: JSON.stringify({ label }) }).catch(() => {})
    onChanged()
  }

  async function addTab() {
    const r = await api<{ tab: DashboardTab }>(`/api/v1/dashboards/${dashboardId}/tabs`, {
      method: 'POST', body: JSON.stringify({ label: 'Nova aba' }),
    }).catch(() => null)
    if (r?.tab) onChanged({ switchTo: r.tab.id })
  }

  async function removeTab(tab: DashboardTab) {
    if (tabs.length <= 1) return
    if (!(await confirm({
      title: 'Excluir aba',
      message: `Excluir a aba "${tab.label}" e todos os seus widgets? Esta ação não pode ser desfeita.`,
      danger: true, confirmLabel: 'Excluir',
    }))) return
    await api(`/api/v1/dashboards/${dashboardId}/tabs/${tab.id}`, { method: 'DELETE' }).catch(() => {})
    const fallback = tabs.find((t) => t.id !== tab.id)?.id
    onChanged(fallback ? { switchTo: fallback } : undefined)
  }

  return (
    <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div key={tab.id} className="group relative">
            {editingId === tab.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => rename(tab.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') rename(tab.id); if (e.key === 'Escape') setEditingId(null) }}
                className="w-28 rounded-t-lg border-b-2 border-accent bg-transparent px-3 py-2 text-sm outline-none"
              />
            ) : (
              <button
                onClick={() => onSwitch(tab.id)}
                onDoubleClick={() => { if (editMode) { setEditingId(tab.id); setDraft(tab.label) } }}
                title={editMode ? 'Duplo-clique para renomear' : undefined}
                className={clsx(
                  'flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
                  active
                    ? 'border-accent font-semibold text-zinc-900 dark:text-zinc-100'
                    : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
                )}
              >
                <span className="max-w-[160px] truncate">{tab.label}</span>
                {editMode && tabs.length > 1 && (
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); void removeTab(tab) }}
                    className="rounded p-0.5 text-zinc-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 dark:text-zinc-600"
                    title="Excluir aba"
                  >
                    <X size={12} />
                  </span>
                )}
              </button>
            )}
          </div>
        )
      })}
      {editMode && (
        <button
          onClick={addTab}
          className="ml-1 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-accent dark:hover:bg-zinc-800"
          title="Adicionar aba"
        >
          <Plus size={14} /> Aba
        </button>
      )}
    </div>
  )
}
