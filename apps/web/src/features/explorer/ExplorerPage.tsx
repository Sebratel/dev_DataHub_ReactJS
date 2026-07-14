// ─────────────────────────────────────────────────────────────────────────
// Explorador de Dados — grade estilo Airtable sobre o lake:
// busca, filtros por campo, ordenação por clique no cabeçalho, agrupamento
// (com contagem), ocultar colunas, paginação, visualizações salvas e export.
// Todo o estado da tela é um ViewDefinition — o que se salva/compartilha.
// ─────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, ArrowDown, ArrowUp, Columns3, Download, Filter, Layers,
  Loader2, Plus, Save, Search, Trash2, X, ChevronLeft, ChevronRight, Bookmark,
} from 'lucide-react'
import clsx from 'clsx'
import type {
  DatasetDetail, QueryDef, QueryFilter, QueryResult, SavedView, ViewDefinition, FilterOp,
} from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'

const OPS_BY_TYPE: Record<string, { op: FilterOp; label: string; noValue?: boolean }[]> = {
  text: [
    { op: 'contains', label: 'contém' }, { op: '=', label: 'igual a' }, { op: '!=', label: 'diferente de' },
    { op: 'starts_with', label: 'começa com' }, { op: 'is_null', label: 'está vazio', noValue: true },
    { op: 'not_null', label: 'não está vazio', noValue: true },
  ],
  number: [
    { op: '=', label: '=' }, { op: '!=', label: '≠' }, { op: '>', label: '>' }, { op: '>=', label: '≥' },
    { op: '<', label: '<' }, { op: '<=', label: '≤' }, { op: 'is_null', label: 'está vazio', noValue: true },
  ],
  date: [
    { op: '>=', label: 'a partir de' }, { op: '<=', label: 'até' }, { op: '=', label: 'em' },
    { op: 'is_null', label: 'está vazio', noValue: true },
  ],
  bool: [{ op: '=', label: 'igual a' }],
  json: [{ op: 'is_null', label: 'está vazio', noValue: true }, { op: 'not_null', label: 'não está vazio', noValue: true }],
}

const PAGE_SIZE = 50

export default function ExplorerPage() {
  const { slug } = useParams()
  const user = useAuthStore((s) => s.user)
  const [dataset, setDataset] = useState<DatasetDetail | null>(null)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Estado da visualização (= ViewDefinition)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<QueryFilter[]>([])
  const [orderBy, setOrderBy] = useState<{ field: string; dir: 'asc' | 'desc' }[]>([])
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [page, setPage] = useState(0)

  // UI auxiliar
  const [showColumns, setShowColumns] = useState(false)
  const [showFilterForm, setShowFilterForm] = useState(false)
  const [views, setViews] = useState<SavedView[]>([])
  const [exporting, setExporting] = useState<string | null>(null)

  // Rascunho do filtro novo
  const [fField, setFField] = useState('')
  const [fOp, setFOp] = useState<FilterOp>('contains')
  const [fValue, setFValue] = useState('')

  useEffect(() => {
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => {
        setDataset(r.dataset)
        void api<{ views: SavedView[] }>(`/api/v1/datasets/${r.dataset.id}/views`).then((v) => setViews(v.views))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [slug])

  const visibleFields = useMemo(
    () => (dataset?.fields ?? []).filter((f) => !f.hidden),
    [dataset],
  )
  const shownFields = visibleFields.filter((f) => !hiddenColumns.includes(f.key))

  // QueryDef derivado do estado da tela.
  const queryDef: QueryDef = useMemo(() => {
    if (groupBy) {
      return {
        dataset: slug!,
        select: [groupBy, { field: groupBy, agg: 'count', as: 'registros' }],
        filters, search: search || undefined,
        groupBy: [groupBy],
        orderBy: [{ field: 'registros', dir: 'desc' }],
        limit: 500,
      }
    }
    return {
      dataset: slug!,
      select: shownFields.map((f) => f.key),
      filters, search: search || undefined,
      orderBy: orderBy.length ? orderBy : undefined,
      limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, filters, search, orderBy, groupBy, page, hiddenColumns, dataset])

  const runQuery = useCallback(() => {
    if (!dataset) return
    setBusy(true)
    setError(null)
    api<QueryResult>(`/api/v1/datasets/${slug}/query`, { method: 'POST', body: JSON.stringify(queryDef) })
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha na consulta.'))
      .finally(() => setBusy(false))
  }, [dataset, slug, queryDef])

  useEffect(() => { runQuery() }, [runQuery])

  function toggleSort(key: string) {
    setPage(0)
    setOrderBy((prev) => {
      const cur = prev.find((o) => o.field === key)
      if (!cur) return [{ field: key, dir: 'asc' }]
      if (cur.dir === 'asc') return [{ field: key, dir: 'desc' }]
      return []
    })
  }

  function addFilter() {
    if (!fField) return
    const needsValue = !OPS_BY_TYPE[fieldType(fField)]?.find((o) => o.op === fOp)?.noValue
    const field = visibleFields.find((f) => f.key === fField)
    let value: unknown = fValue
    if (needsValue && field?.type === 'number') value = Number(fValue)
    if (field?.type === 'bool') value = fValue === 'true'
    setFilters((prev) => [...prev, { field: fField, op: fOp, ...(needsValue ? { value } : {}) }])
    setShowFilterForm(false)
    setFField(''); setFValue(''); setFOp('contains')
    setPage(0)
  }

  function fieldType(key: string): string {
    return visibleFields.find((f) => f.key === key)?.type ?? 'text'
  }
  function fieldLabel(key: string): string {
    return dataset?.fields.find((f) => f.key === key)?.label ?? key
  }
  function opLabel(type: string, op: FilterOp): string {
    return OPS_BY_TYPE[type]?.find((o) => o.op === op)?.label ?? op
  }

  const definition: ViewDefinition = { filters, orderBy, groupBy, hiddenColumns, search }
  function applyDefinition(d: ViewDefinition) {
    setFilters(d.filters ?? [])
    setOrderBy(d.orderBy ?? [])
    setGroupBy(d.groupBy ?? null)
    setHiddenColumns(d.hiddenColumns ?? [])
    setSearch(d.search ?? '')
    setPage(0)
  }

  async function saveView() {
    if (!dataset) return
    const name = window.prompt('Nome da visualização:')
    if (!name) return
    const shared = window.confirm('Compartilhar com toda a equipe? (Cancelar = só para você)')
    try {
      const r = await api<{ view: SavedView }>(`/api/v1/datasets/${dataset.id}/views`, {
        method: 'POST', body: JSON.stringify({ name, definition, shared }),
      })
      setViews((v) => [r.view, ...v])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar visualização.')
    }
  }

  async function deleteView(id: string) {
    if (!dataset || !window.confirm('Excluir esta visualização?')) return
    try {
      await api(`/api/v1/datasets/${dataset.id}/views/${id}`, { method: 'DELETE' })
      setViews((v) => v.filter((x) => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
    }
  }

  async function doExport(format: 'csv' | 'xlsx') {
    setExporting(format)
    setError(null)
    try {
      const token = useAuthStore.getState().accessToken
      const r = await fetch(`/api/v1/datasets/${slug}/export?format=${format}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...queryDef, limit: undefined, offset: undefined }),
      })
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error || `Erro ${r.status}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha no export.')
    } finally {
      setExporting(null)
    }
  }

  if (error && !dataset) {
    return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
  }
  if (!dataset) return <p className="text-sm text-zinc-500">Carregando…</p>

  const totalPages = result?.total !== undefined ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : null

  return (
    <div className="mx-auto max-w-6xl">
      <Link to={`/datasets/${slug}`} className="mb-3 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-accent">
        <ArrowLeft size={14} /> {dataset.name}
      </Link>
      <h1 className="text-xl font-semibold">Explorador — {dataset.name}</h1>

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder="Buscar…"
            className="w-52 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        <button onClick={() => setShowFilterForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          <Filter size={14} /> Filtro
        </button>

        <label className="flex items-center gap-1.5 text-sm">
          <Layers size={14} className="text-zinc-400" />
          <select
            value={groupBy ?? ''}
            onChange={(e) => { setGroupBy(e.target.value || null); setPage(0) }}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Sem agrupamento</option>
            {visibleFields.map((f) => <option key={f.key} value={f.key}>Agrupar: {f.label}</option>)}
          </select>
        </label>

        <div className="relative">
          <button onClick={() => setShowColumns((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <Columns3 size={14} /> Colunas
          </button>
          {showColumns && (
            <div className="absolute z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              {visibleFields.map((f) => (
                <label key={f.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
                  <input
                    type="checkbox"
                    checked={!hiddenColumns.includes(f.key)}
                    onChange={(e) => setHiddenColumns((prev) =>
                      e.target.checked ? prev.filter((k) => k !== f.key) : [...prev, f.key])}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Visualizações salvas */}
          {views.length > 0 && (
            <select
              onChange={(e) => {
                const v = views.find((x) => x.id === e.target.value)
                if (v) applyDefinition(v.definition)
                e.target.value = ''
              }}
              defaultValue=""
              className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="" disabled>Visualizações…</option>
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.shared ? ' (equipe)' : ''}{v.ownerEmail === user?.email ? '' : ` — ${v.ownerEmail.split('@')[0]}`}
                </option>
              ))}
            </select>
          )}
          <button onClick={saveView} title="Salvar visualização atual"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <Save size={14} /> Salvar
          </button>
          <button onClick={() => doExport('csv')} disabled={exporting !== null}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            {exporting === 'csv' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} CSV
          </button>
          <button onClick={() => doExport('xlsx')} disabled={exporting !== null}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            {exporting === 'xlsx' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Excel
          </button>
        </div>
      </div>

      {/* Form de filtro novo */}
      {showFilterForm && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
          <select value={fField} onChange={(e) => { setFField(e.target.value); setFOp(OPS_BY_TYPE[fieldType(e.target.value)][0].op) }}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
            <option value="">Campo…</option>
            {visibleFields.filter((f) => !f.sensitive || user?.roles.includes('admin')).map((f) =>
              <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          {fField && (
            <select value={fOp} onChange={(e) => setFOp(e.target.value as FilterOp)}
              className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              {OPS_BY_TYPE[fieldType(fField)].map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
          )}
          {fField && !OPS_BY_TYPE[fieldType(fField)].find((o) => o.op === fOp)?.noValue && (
            fieldType(fField) === 'bool' ? (
              <select value={fValue} onChange={(e) => setFValue(e.target.value)}
                className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                <option value="true">Sim</option><option value="false">Não</option>
              </select>
            ) : (
              <input
                value={fValue}
                onChange={(e) => setFValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addFilter()}
                type={fieldType(fField) === 'number' ? 'number' : fieldType(fField) === 'date' ? 'date' : 'text'}
                placeholder="Valor"
                className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            )
          )}
          <button onClick={addFilter} disabled={!fField}
            className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50">
            <Plus size={14} /> Adicionar
          </button>
        </div>
      )}

      {/* Chips de filtros ativos */}
      {filters.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {filters.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent dark:bg-zinc-800 dark:text-zinc-200">
              {fieldLabel(f.field)} {opLabel(fieldType(f.field), f.op)} {f.value !== undefined ? String(f.value) : ''}
              <button onClick={() => { setFilters((prev) => prev.filter((_, j) => j !== i)); setPage(0) }}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      {/* Grade */}
      <div className="relative mt-4 max-h-[560px] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        {busy && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 dark:bg-zinc-950/60">
            <Loader2 size={20} className="animate-spin text-accent" />
          </div>
        )}
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-[5] bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
            <tr>
              {(result?.columns ?? []).map((c) => {
                const sort = orderBy.find((o) => o.field === c.name)
                return (
                  <th
                    key={c.name}
                    onClick={() => !groupBy && toggleSort(c.name)}
                    className={clsx('whitespace-nowrap px-3 py-2 font-medium', !groupBy && 'cursor-pointer select-none hover:text-accent')}
                  >
                    <span className="inline-flex items-center gap-1">
                      {fieldLabel(c.name)}
                      {sort && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-zinc-950">
            {(result?.rows ?? []).map((row, i) => (
              <tr key={i} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                {(result?.columns ?? []).map((c) => (
                  <td key={c.name} className="max-w-[260px] truncate whitespace-nowrap px-3 py-1.5">
                    {row[c.name] === null || row[c.name] === undefined ? '—' : String(row[c.name])}
                  </td>
                ))}
              </tr>
            ))}
            {result && result.rows.length === 0 && (
              <tr><td className="px-3 py-8 text-center text-zinc-400" colSpan={result.columns.length || 1}>Nenhum registro encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Rodapé: paginação e stats */}
      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span>
          {result?.total !== undefined && `${result.total.toLocaleString('pt-BR')} registros`}
          {groupBy && result && `${result.rows.length} grupos`}
          {result && ` · ${result.tookMs} ms`}
        </span>
        {!groupBy && totalPages !== null && totalPages > 1 && (
          <span className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
              className="rounded p-1 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"><ChevronLeft size={15} /></button>
            página {page + 1} de {totalPages}
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="rounded p-1 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"><ChevronRight size={15} /></button>
          </span>
        )}
      </div>

      {/* Gestão das visualizações do usuário */}
      {views.some((v) => v.ownerEmail === user?.email) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <Bookmark size={13} /> Minhas visualizações:
          {views.filter((v) => v.ownerEmail === user?.email).map((v) => (
            <span key={v.id} className="flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-zinc-700">
              <button onClick={() => applyDefinition(v.definition)} className="hover:text-accent">{v.name}</button>
              <button onClick={() => deleteView(v.id)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600"><Trash2 size={11} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
