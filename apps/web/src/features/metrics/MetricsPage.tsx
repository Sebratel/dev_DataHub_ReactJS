// Biblioteca de Métricas — definições únicas e reutilizáveis (Receita, Churn…),
// cada uma amarrada a um dataset e usável em dashboards e na IA.
import { useEffect, useState } from 'react'
import { Ruler, Plus, Trash2, Loader2 } from 'lucide-react'
import type { Metric, DatasetSummary, DatasetDetail, Aggregation } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'

const AGG_LABEL: Record<string, string> = {
  sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo',
  count: 'Contagem', count_distinct: 'Contagem distinta',
}
const FORMAT_LABEL: Record<string, string> = { number: 'Número', currency: 'R$ Moeda', percent: '% Percentual' }

export default function MetricsPage() {
  const user = useAuthStore((s) => s.user)
  const confirm = useConfirm()
  const canEdit = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [metrics, setMetrics] = useState<Metric[] | null>(null)
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  // Form
  const [fDataset, setFDataset] = useState('')
  const [fields, setFields] = useState<DatasetDetail['fields']>([])
  const [fName, setFName] = useState('')
  const [fAgg, setFAgg] = useState<Aggregation>('sum')
  const [fField, setFField] = useState('')
  const [fFormat, setFFormat] = useState<Metric['format']>('number')
  const [saving, setSaving] = useState(false)

  function load() {
    api<{ metrics: Metric[] }>('/api/v1/metrics').then((r) => setMetrics(r.metrics))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar métricas.'))
  }
  useEffect(() => {
    load()
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets))
      .catch(() => setError('Não foi possível carregar os conjuntos de dados — verifique se a API está no ar.'))
  }, [])

  useEffect(() => {
    if (!fDataset) { setFields([]); return }
    const slug = datasets.find((d) => d.id === fDataset)?.slug
    if (!slug) return
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => setFields(r.dataset.fields.filter((f) => !f.hidden)))
      .catch(() => setFields([]))
  }, [fDataset, datasets])

  async function create() {
    setSaving(true)
    setError(null)
    try {
      await api('/api/v1/metrics', {
        method: 'POST',
        body: JSON.stringify({ datasetId: fDataset, name: fName, agg: fAgg, fieldKey: fField, format: fFormat }),
      })
      setShowForm(false)
      setFName(''); setFField(''); setFAgg('sum'); setFFormat('number')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar métrica.')
    } finally {
      setSaving(false)
    }
  }

  async function remove(m: Metric) {
    if (!(await confirm({
      title: 'Excluir métrica',
      message: `Excluir a métrica "${m.name}"? Widgets que a usam vão quebrar.`,
      danger: true, confirmLabel: 'Excluir',
    }))) return
    try {
      await api(`/api/v1/metrics/${m.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
    }
  }

  const byDataset = new Map<string, Metric[]>()
  for (const m of metrics ?? []) {
    byDataset.set(m.datasetName, [...(byDataset.get(m.datasetName) ?? []), m])
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Biblioteca de Métricas</h1>
          <p className="mt-1 text-sm text-zinc-500">Definições únicas, reutilizáveis em dashboards e pela IA.</p>
        </div>
        {canEdit && (
          <button onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover">
            <Plus size={15} /> Nova métrica
          </button>
        )}
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      {showForm && (
        <div className="mt-5 grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Nome (ex.: Receita, Chamados Abertos)</span>
            <input value={fName} onChange={(e) => setFName(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Conjunto de dados</span>
            <select value={fDataset} onChange={(e) => setFDataset(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value="">— escolha —</option>
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Agregação</span>
            <select value={fAgg} onChange={(e) => setFAgg(e.target.value as Aggregation)}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              {Object.entries(AGG_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Campo</span>
            <select value={fField} onChange={(e) => setFField(e.target.value)} disabled={!fields.length}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value="">— escolha —</option>
              {fields.filter((f) => ['count', 'count_distinct'].includes(fAgg) || f.type === 'number')
                .map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Formato</span>
            <select value={fFormat} onChange={(e) => setFFormat(e.target.value as Metric['format'])}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              {Object.entries(FORMAT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <button onClick={create} disabled={saving || !fName || !fDataset || !fField}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />} Criar métrica
            </button>
          </div>
        </div>
      )}

      {metrics === null && !error && <p className="mt-6 text-sm text-zinc-500">Carregando…</p>}
      {metrics?.length === 0 && !showForm && (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nenhuma métrica ainda. {canEdit ? 'Crie a primeira — ela ficará disponível nos dashboards.' : 'Peça a um editor para criar.'}
        </div>
      )}

      {[...byDataset.entries()].map(([dsName, list]) => (
        <div key={dsName} className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-400">{dsName}</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {list.map((m) => (
              <div key={m.id} className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent dark:bg-zinc-800">
                  <Ruler size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{m.name}</p>
                  <p className="text-xs text-zinc-500">
                    {AGG_LABEL[m.agg]} de {m.fieldKey} · {FORMAT_LABEL[m.format]}
                  </p>
                </div>
                {canEdit && (
                  <button onClick={() => remove(m)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
