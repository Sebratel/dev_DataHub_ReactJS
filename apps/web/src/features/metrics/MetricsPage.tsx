// Biblioteca de Métricas — definições únicas e reutilizáveis (Receita, Churn…),
// cada uma amarrada a um dataset e usável em dashboards e na IA.
// A métrica pode ter FILTROS embutidos: ex. "contagem distinta de protocolos
// ONDE title = 'instalação' E cliente = X". O compilador os aplica como
// FILTER (WHERE …) na agregação — a métrica carrega a própria condição.
import { useEffect, useState } from 'react'
import { Ruler, Plus, Trash2, Loader2, Filter, X, Pencil, Boxes } from 'lucide-react'
import type { Metric, DatasetSummary, DatasetDetail, Aggregation, QueryFilter } from '@datahub/shared'
import { api } from '@/lib/api'
import { Page, PageHeader, Toolbar, SearchInput, EmptyState, ErrorBanner, TableSkeleton, PrimaryButton } from '@/components/ui/Page'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'

const AGG_LABEL: Record<string, string> = {
  sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo',
  count: 'Contagem', count_distinct: 'Contagem distinta',
}
const FORMAT_LABEL: Record<string, string> = { number: 'Número', currency: 'R$ Moeda', percent: '% Percentual' }
// Operadores oferecidos no construtor de filtros (os mesmos do compilador).
const OPS: { op: QueryFilter['op']; label: string; noValue?: boolean }[] = [
  { op: '=', label: 'igual a' },
  { op: '!=', label: 'diferente de' },
  { op: '>', label: 'maior que' },
  { op: '>=', label: 'maior ou igual' },
  { op: '<', label: 'menor que' },
  { op: '<=', label: 'menor ou igual' },
  { op: 'contains', label: 'contém' },
  { op: 'starts_with', label: 'começa com' },
  { op: 'in', label: 'está em (vírgula)' },
  { op: 'not_in', label: 'não está em (vírgula)' },
  { op: 'is_null', label: 'está vazio', noValue: true },
  { op: 'not_null', label: 'não está vazio', noValue: true },
]
const opLabel = (op: string) => OPS.find((o) => o.op === op)?.label ?? op
const noValueOp = (op: string) => !!OPS.find((o) => o.op === op)?.noValue

// Resumo legível dos filtros para o cartão da métrica.
function filtersSummary(filters: QueryFilter[], labelOf: (k: string) => string): string {
  return filters.map((f) => {
    const v = Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')
    return noValueOp(f.op) ? `${labelOf(f.field)} ${opLabel(f.op)}` : `${labelOf(f.field)} ${opLabel(f.op)} ${v}`
  }).join(' E ')
}

export default function MetricsPage() {
  const user = useAuthStore((s) => s.user)
  const confirm = useConfirm()
  const canEdit = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [metrics, setMetrics] = useState<Metric[] | null>(null)
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<Metric | 'new' | null>(null)

  function load() {
    api<{ metrics: Metric[] }>('/api/v1/metrics').then((r) => setMetrics(r.metrics))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar métricas.'))
  }
  useEffect(() => {
    load()
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets))
      .catch(() => setError('Não foi possível carregar os conjuntos de dados — verifique se a API está no ar.'))
  }, [])

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

  const list = metrics ?? []
  const filtered = list.filter((m) => {
    const q = query.toLowerCase().trim()
    return !q || m.name.toLowerCase().includes(q) || m.datasetName.toLowerCase().includes(q)
      || m.fieldKey.toLowerCase().includes(q)
  })
  const withFilters = list.filter((m) => m.filters?.length > 0).length
  const datasetsUsed = new Set(list.map((m) => m.datasetName)).size

  const kpis: Kpi[] = [
    { label: 'Métricas', icon: Ruler, value: String(list.length), foot: 'definidas uma vez, usadas em tudo' },
    { label: 'Conjuntos cobertos', icon: Boxes, value: String(datasetsUsed), foot: `de ${datasets.length} disponíveis` },
    { label: 'Com filtro embutido', icon: Filter, value: String(withFilters), foot: 'recorte já na definição' },
  ]

  return (
    <Page>
      <PageHeader
        icon={Ruler}
        title="Biblioteca de métricas"
        subtitle="Definições únicas, reutilizáveis em painéis e pela IA — com filtros embutidos."
      >
        {canEdit && <PrimaryButton icon={Plus} onClick={() => setForm('new')}>Nova métrica</PrimaryButton>}
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      {form && (
        <MetricForm
          initial={form === 'new' ? null : form}
          datasets={datasets}
          onClose={() => setForm(null)}
          onSaved={() => { load(); setForm(null) }}
        />
      )}

      {metrics === null && !error ? <TableSkeleton /> : (
        <div className="flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          <Toolbar>
            <SearchInput value={query} onChange={setQuery} placeholder="Buscar métrica, conjunto ou campo…" />
          </Toolbar>

          <Card>
            <CardHead icon={Ruler} title="Todas as métricas" sub={`${filtered.length} de ${list.length}`} />
            {filtered.length === 0 ? (
              <EmptyState
                icon={Ruler}
                message={query
                  ? 'Nada encontrado para essa busca.'
                  : `Nenhuma métrica ainda. ${canEdit ? 'Crie a primeira — ela fica disponível nos painéis e para a IA.' : 'Peça a um editor para criar.'}`}
                action={canEdit && !query
                  ? <button onClick={() => setForm('new')} className="text-[12px] font-medium text-info hover:underline dark:text-info-dark">Criar métrica</button>
                  : undefined}
              />
            ) : (
              <DataGrid>
                <thead>
                  <tr>
                    <Th>Métrica</Th>
                    <Th className="w-[170px]">Conjunto</Th>
                    <Th className="w-[190px]">Cálculo</Th>
                    <Th className="w-[104px]">Formato</Th>
                    <Th>Filtros embutidos</Th>
                    {canEdit && <Th className="w-[72px]" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <Tr key={m.id}>
                      <Td>
                        <EntityCell name={m.name}>
                          <Ruler size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                        </EntityCell>
                      </Td>
                      <Td muted>{m.datasetName}</Td>
                      <Td muted>
                        <span className="text-zinc-700 dark:text-zinc-300">{AGG_LABEL[m.agg]}</span>
                        {' de '}
                        <span className="font-mono text-[10.5px]">{m.fieldKey}</span>
                      </Td>
                      <Td muted>{FORMAT_LABEL[m.format]}</Td>
                      <Td>
                        {m.filters?.length > 0
                          ? <span className="flex items-start gap-1 text-[11px] text-zinc-500">
                              <Filter size={11} className="mt-0.5 shrink-0" />
                              <span className="min-w-0">{filtersSummary(m.filters, (k) => k)}</span>
                            </span>
                          : <span className="text-[11px] text-zinc-400">nenhum</span>}
                      </Td>
                      {canEdit && (
                        <Td>
                          <span className="flex items-center justify-end gap-0.5">
                            <button onClick={() => setForm(m)} title="Editar métrica"
                              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                              <Pencil size={13} />
                            </button>
                            <button onClick={() => remove(m)} title="Excluir"
                              className="rounded p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit dark:hover:bg-crit/15">
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </div>
      )}
    </Page>
  )
}

// ── Formulário (criar/editar) com construtor de filtros ─────────
function MetricForm({ initial, datasets, onClose, onSaved }: {
  initial: Metric | null
  datasets: DatasetSummary[]
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const [fields, setFields] = useState<DatasetDetail['fields']>([])
  const [dataset, setDataset] = useState(initial?.datasetId ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [agg, setAgg] = useState<Aggregation>(initial?.agg ?? 'sum')
  const [field, setField] = useState(initial?.fieldKey ?? '')
  const [format, setFormat] = useState<Metric['format']>(initial?.format ?? 'number')
  const [filters, setFilters] = useState<QueryFilter[]>(initial?.filters ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!dataset) { setFields([]); return }
    const slug = datasets.find((d) => d.id === dataset)?.slug
    if (!slug) return
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => setFields(r.dataset.fields.filter((f) => !f.hidden)))
      .catch(() => setFields([]))
  }, [dataset, datasets])

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const setFilter = (i: number, patch: Partial<QueryFilter>) =>
    setFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))

  async function save() {
    setSaving(true)
    setError(null)
    // Operadores de lista aceitam "a, b, c"; os de vazio não mandam valor.
    const payloadFilters = filters
      .filter((f) => f.field)
      .map((f) => {
        if (noValueOp(f.op)) return { field: f.field, op: f.op }
        const raw = f.value
        const value = (f.op === 'in' || f.op === 'not_in') && typeof raw === 'string'
          ? raw.split(',').map((s) => s.trim()).filter(Boolean)
          : raw
        return { field: f.field, op: f.op, value }
      })
    try {
      if (isEdit) {
        await api(`/api/v1/metrics/${initial!.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, agg, fieldKey: field, format, filters: payloadFilters }),
        })
      } else {
        await api('/api/v1/metrics', {
          method: 'POST',
          body: JSON.stringify({ datasetId: dataset, name, agg, fieldKey: field, format, filters: payloadFilters }),
        })
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar a métrica.')
      setSaving(false)
    }
  }

  const valid = name.trim() && dataset && field

  return (
    <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{isEdit ? `Editar métrica “${initial!.name}”` : 'Nova métrica'}</h2>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Nome (ex.: Protocolos de instalação)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inp} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Conjunto de dados</span>
          <select value={dataset} onChange={(e) => setDataset(e.target.value)} className={inp} disabled={isEdit}>
            <option value="">— escolha —</option>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Agregação</span>
          <select value={agg} onChange={(e) => setAgg(e.target.value as Aggregation)} className={inp}>
            {Object.entries(AGG_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Campo</span>
          <select value={field} onChange={(e) => setField(e.target.value)} disabled={!fields.length} className={inp}>
            <option value="">— escolha —</option>
            {fields.filter((f) => ['count', 'count_distinct'].includes(agg) || f.type === 'number')
              .map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Formato</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as Metric['format'])} className={inp}>
            {Object.entries(FORMAT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      {/* Construtor de filtros — o que faltava: "onde title = instalação E cliente = X" */}
      <div className="mt-4 rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
            <Filter size={12} /> Filtros da métrica (opcional — todos combinados com E)
          </span>
          <button onClick={() => setFilters((f) => [...f, { field: '', op: '=', value: '' }])}
            disabled={!fields.length}
            className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:text-accent disabled:opacity-40 dark:border-zinc-700">
            <Plus size={12} /> Filtro
          </button>
        </div>
        <div className="grid gap-1.5">
          {filters.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <select value={f.field} onChange={(e) => setFilter(i, { field: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                <option value="">— campo —</option>
                {fields.map((ff) => <option key={ff.key} value={ff.key}>{ff.label}</option>)}
              </select>
              <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as QueryFilter['op'] })}
                className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
              </select>
              {!noValueOp(f.op) && (
                <input
                  value={Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')}
                  onChange={(e) => setFilter(i, { value: e.target.value })}
                  placeholder={f.op === 'in' || f.op === 'not_in' ? 'valor1, valor2' : 'valor'}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
              )}
              <button onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
                className="shrink-0 text-zinc-400 hover:text-red-500"><X size={14} /></button>
            </div>
          ))}
          {filters.length === 0 && (
            <p className="text-[11px] text-zinc-400">
              Sem filtros — a métrica considera todas as linhas. Ex.: adicione “title igual a instalação” e “cliente igual a X”.
            </p>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button onClick={save} disabled={saving || !valid}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {saving && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Salvar alterações' : 'Criar métrica'}
        </button>
        <button onClick={onClose} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Cancelar
        </button>
      </div>
    </div>
  )
}
