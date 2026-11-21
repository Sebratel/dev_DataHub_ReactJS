// Formulário de métrica (criar/editar) com construtor de filtros, e os rótulos
// que a biblioteca e a seção "Métricas" do conjunto compartilham.
// A métrica pode ter FILTROS embutidos: ex. "contagem distinta de protocolos
// ONDE title = 'instalação' E cliente = X". O compilador os aplica como
// FILTER (WHERE …) na agregação — a métrica carrega a própria condição.
import { useEffect, useState } from 'react'
import { Plus, Loader2, Filter, X } from 'lucide-react'
import type { Metric, DatasetDetail, Aggregation, QueryFilter } from '@datahub/shared'
import { api } from '@/lib/api'

export const AGG_LABEL: Record<string, string> = {
  sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo',
  count: 'Contagem', count_distinct: 'Contagem distinta',
}
export const FORMAT_LABEL: Record<string, string> = { number: 'Número', currency: 'R$ Moeda', percent: '% Percentual' }
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

/** Resumo legível dos filtros de uma métrica. */
export function filtersSummary(filters: QueryFilter[], labelOf: (k: string) => string): string {
  return filters.map((f) => {
    const v = Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')
    return noValueOp(f.op) ? `${labelOf(f.field)} ${opLabel(f.op)}` : `${labelOf(f.field)} ${opLabel(f.op)} ${v}`
  }).join(' E ')
}

/** O mínimo de um conjunto que o formulário precisa. */
export interface DatasetOption { id: string; slug: string; name: string }

export function MetricForm({ initial, datasets, fixedDataset, onClose, onSaved }: {
  initial: Metric | null
  /** Conjuntos para escolher (biblioteca). Ignorado quando há `fixedDataset`. */
  datasets?: DatasetOption[]
  /** Conjunto já escolhido (seção "Métricas" dentro do conjunto). */
  fixedDataset?: DatasetOption
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const opcoes = fixedDataset ? [fixedDataset] : (datasets ?? [])
  const [fields, setFields] = useState<DatasetDetail['fields']>([])
  const [dataset, setDataset] = useState(initial?.datasetId ?? fixedDataset?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [agg, setAgg] = useState<Aggregation>(initial?.agg ?? 'sum')
  const [field, setField] = useState(initial?.fieldKey ?? '')
  const [format, setFormat] = useState<Metric['format']>(initial?.format ?? 'number')
  const [filters, setFilters] = useState<QueryFilter[]>(initial?.filters ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slugEscolhido = opcoes.find((d) => d.id === dataset)?.slug
  useEffect(() => {
    if (!slugEscolhido) { setFields([]); return }
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slugEscolhido}`)
      .then((r) => setFields(r.dataset.fields.filter((f) => !f.hidden)))
      .catch(() => setFields([]))
  }, [slugEscolhido])

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
    <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
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
          <select value={dataset} onChange={(e) => setDataset(e.target.value)} className={inp} disabled={isEdit || !!fixedDataset}>
            <option value="">— escolha —</option>
            {opcoes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
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

      {/* Construtor de filtros — "onde title = instalação E cliente = X" */}
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
