// Editor dos filtros da aba (modo edição). O admin/dono escolhe um conjunto
// (entre os usados pelos widgets da aba), um campo e um rótulo. O tipo do
// filtro sai do tipo do campo: data → intervalo; demais → multiseleção.
import { useEffect, useState } from 'react'
import { X, Loader2, Plus, Trash2 } from 'lucide-react'
import type { DatasetSummary, DatasetDetail, DashboardTab, TabFilter, TabConfig } from '@datahub/shared'
import { api } from '@/lib/api'

interface Props {
  dashboardId: string
  tab: DashboardTab
  tabDatasetSlugs: string[]
  onClose: () => void
  onSaved: () => void
}

export default function TabFiltersDialog({ dashboardId, tab, tabDatasetSlugs, onClose, onSaved }: Props) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [filters, setFilters] = useState<TabFilter[]>(tab.config?.filters ?? [])
  const [dsSlug, setDsSlug] = useState('')
  const [fields, setFields] = useState<DatasetDetail['fields']>([])
  const [field, setField] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets.filter((d) => tabDatasetSlugs.includes(d.slug))))
      .catch(() => {})
  }, [tabDatasetSlugs])

  useEffect(() => {
    if (!dsSlug) { setFields([]); return }
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${dsSlug}`)
      .then((r) => setFields(r.dataset.fields.filter((f) => !f.hidden && !f.sensitive)))
      .catch(() => {})
    setField('')
  }, [dsSlug])

  function addFilter() {
    const f = fields.find((x) => x.key === field)
    if (!dsSlug || !f) return
    const kind: TabFilter['kind'] = f.type === 'date' ? 'daterange' : 'multiselect'
    setFilters((prev) => [...prev, { field: f.key, label: label.trim() || f.label, kind, datasetSlug: dsSlug }])
    setField(''); setLabel('')
  }

  async function save() {
    setSaving(true); setError(null)
    const config: TabConfig = { ...(tab.config ?? {}), filters }
    try {
      await api(`/api/v1/dashboards/${dashboardId}/tabs/${tab.id}`, { method: 'PATCH', body: JSON.stringify({ config }) })
      onSaved(); onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.'); setSaving(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Filtros da aba “{tab.label}”</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>

        {filters.length > 0 && (
          <div className="mb-3 grid gap-1.5">
            {filters.map((f, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                <span className="flex-1 truncate">{f.label} <span className="text-xs text-zinc-400">· {f.datasetSlug} · {f.kind === 'daterange' ? 'intervalo' : 'multiseleção'}</span></span>
                <button onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}

        {tabDatasetSlugs.length === 0 ? (
          <p className="text-sm text-zinc-500">Adicione widgets à aba antes de criar filtros.</p>
        ) : (
          <div className="grid gap-2 rounded-xl border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
            <select value={dsSlug} onChange={(e) => setDsSlug(e.target.value)} className={inp}>
              <option value="">— conjunto —</option>
              {datasets.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            </select>
            <select value={field} onChange={(e) => setField(e.target.value)} className={inp} disabled={!fields.length}>
              <option value="">— campo —</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}{f.type === 'date' ? ' (data)' : ''}</option>)}
            </select>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={inp} placeholder="Rótulo (opcional)" />
            <button onClick={addFilter} disabled={!field}
              className="flex w-fit items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:text-accent disabled:opacity-40 dark:border-zinc-700">
              <Plus size={14} /> Adicionar filtro
            </button>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <button onClick={save} disabled={saving}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {saving && <Loader2 size={14} className="animate-spin" />} Salvar filtros
        </button>
      </div>
    </div>
  )
}
