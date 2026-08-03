// Barra de filtros da aba (visualização): um controle por filtro. Multiselect
// carrega os valores distintos do conjunto sob demanda; intervalo de datas usa
// dois campos. As seleções ficam no estado da página e recarregam os widgets.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Filter, X } from 'lucide-react'
import type { TabFilter, QueryResult } from '@datahub/shared'
import { api } from '@/lib/api'
import type { FilterValue, FilterValues } from './tabFilters'

function MultiSelect({ filter, selected, onChange }: {
  filter: TabFilter; selected: string[]; onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<string[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || options) return
    api<QueryResult>(`/api/v1/datasets/${filter.datasetSlug}/query`, {
      method: 'POST',
      body: JSON.stringify({
        dataset: filter.datasetSlug, select: [filter.field],
        groupBy: [filter.field], orderBy: [{ field: filter.field, dir: 'asc' }], limit: 500,
      }),
    })
      .then((r) => setOptions(r.rows.map((row) => String(row[filter.field] ?? '')).filter(Boolean)))
      .catch(() => setOptions([]))
  }, [open, options, filter.datasetSlug, filter.field])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const label = filter.label || filter.field
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900">
        <Filter size={12} className="text-zinc-400" />
        {label}{selected.length > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] text-zinc-950">{selected.length}</span>}
        <ChevronDown size={12} className="text-zinc-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-64 w-56 overflow-auto rounded-lg border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {options === null && <p className="p-2 text-xs text-zinc-400">Carregando…</p>}
          {options?.length === 0 && <p className="p-2 text-xs text-zinc-400">Sem valores.</p>}
          {options?.map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <input type="checkbox" checked={selected.includes(opt)}
                onChange={(e) => onChange(e.target.checked ? [...selected, opt] : selected.filter((s) => s !== opt))} />
              <span className="truncate">{opt}</span>
            </label>
          ))}
          {!!selected.length && (
            <button onClick={() => onChange([])} className="mt-1 w-full rounded px-2 py-1 text-left text-[11px] text-zinc-400 hover:text-red-500">
              Limpar seleção
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function DateRange({ filter, value, onChange }: {
  filter: TabFilter; value: { from: string; to: string }; onChange: (v: { from: string; to: string }) => void
}) {
  const inp = 'rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900'
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-zinc-500">{filter.label || filter.field}:</span>
      <input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className={inp} />
      <span className="text-xs text-zinc-400">→</span>
      <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className={inp} />
    </div>
  )
}

interface Props {
  filters: TabFilter[]
  values: FilterValues
  onChange: (v: FilterValues) => void
}

export default function FilterBar({ filters, values, onChange }: Props) {
  if (!filters.length) return null
  const set = (i: number, v: FilterValue) => onChange({ ...values, [i]: v })
  const hasAny = Object.values(values).some((v) => Array.isArray(v) ? v.length : (v.from || v.to))

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {filters.map((f, i) => f.kind === 'multiselect' ? (
        <MultiSelect key={i} filter={f} selected={(values[i] as string[]) ?? []} onChange={(v) => set(i, v)} />
      ) : (
        <DateRange key={i} filter={f} value={(values[i] as { from: string; to: string }) ?? { from: '', to: '' }} onChange={(v) => set(i, v)} />
      ))}
      {hasAny && (
        <button onClick={() => onChange({})} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-red-500">
          <X size={12} /> Limpar filtros
        </button>
      )}
    </div>
  )
}
