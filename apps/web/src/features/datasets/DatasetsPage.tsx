// Catálogo de Datasets — tudo é dataset: FONTES (ingeridas das origens) e
// CALCULADOS (SQL sobre o lake, com selo). Lista única + filtro. O usuário só vê
// nomes amigáveis e apenas os datasets a que tem acesso (o backend já filtra).
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, GitMerge, Database, Search, Plus } from 'lucide-react'
import clsx from 'clsx'
import type { DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import OfficialBadge from '@/components/OfficialBadge'

function relativeTime(iso: string | null): string {
  if (!iso) return 'Nunca sincronizado'
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 60) return `sincronizado há ${Math.max(1, min)} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `sincronizado há ${h} h`
  const d = Math.floor(h / 24)
  return `sincronizado há ${d} dia${d > 1 ? 's' : ''}`
}

function DatasetCard({ d }: { d: DatasetSummary }) {
  const derived = d.kind === 'derived'
  const fresh = !!d.lastSyncAt && Date.now() - new Date(d.lastSyncAt).getTime() < 26 * 3600_000
  return (
    <Link to={`/datasets/${d.slug}`}
      className={clsx('hover-lift group flex flex-col rounded-2xl border bg-white p-3.5 shadow-card hover:shadow-card-md dark:bg-zinc-900',
        d.official
          ? 'border-accent/40 ring-1 ring-accent/20 hover:border-accent'
          : 'border-zinc-200 hover:border-accent dark:border-zinc-800')}>
      <div className="flex items-start gap-3">
        <div className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          derived ? 'bg-gradient-brand text-[#1a1a1a]' : 'bg-accent-soft text-accent dark:bg-zinc-800')}>
          {derived ? <GitMerge size={18} /> : <Database size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate font-semibold group-hover:text-accent">{d.name}</h2>
            <div className="flex shrink-0 items-center gap-1.5">
              {derived && (
                <span className="rounded-full bg-gradient-brand px-2 py-0.5 text-[10px] font-semibold text-[#1a1a1a]">calculado</span>
              )}
              {d.official && <OfficialBadge />}
            </div>
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm text-zinc-500">{d.description || 'Sem descrição.'}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="font-medium tabular-nums">{d.fieldCount} campos</span>
        {d.rowCount !== null && <span className="tabular-nums">· {d.rowCount.toLocaleString('pt-BR')} registros</span>}
      </div>

      {d.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {d.tags.map((t) => (
            <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800">{t}</span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5 border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 dark:border-zinc-800">
        <span className={clsx('h-1.5 w-1.5 rounded-full',
          !d.lastSyncAt ? 'bg-zinc-300 dark:bg-zinc-600' : fresh ? 'bg-emerald-500' : 'bg-amber-500')} />
        {relativeTime(d.lastSyncAt)}
      </div>
    </Link>
  )
}

export default function DatasetsPage() {
  const canEdit = useAuthStore((s) => !!s.user?.roles.some((r) => r === 'admin' || r === 'editor'))
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'source' | 'derived'>('all')

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar o catálogo.'))
  }, [])

  const counts = useMemo(() => ({
    all: datasets?.length ?? 0,
    source: datasets?.filter((d) => d.kind === 'source').length ?? 0,
    derived: datasets?.filter((d) => d.kind === 'derived').length ?? 0,
  }), [datasets])

  const filtered = datasets
    ?.filter((d) => {
      if (filter !== 'all' && d.kind !== filter) return false
      const q = query.toLowerCase()
      return !q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)
        || d.tags.some((t) => t.toLowerCase().includes(q))
    })
    // Oficiais primeiro (fonte de verdade da diretoria), depois por nome.
    .sort((a, b) => Number(b.official) - Number(a.official) || a.name.localeCompare(b.name))

  // Estado vazio ciente do papel: viewer sem NENHUM acesso vê orientação clara
  // (o acesso é fechado por padrão), não a mensagem de "nada publicado".
  const emptyMessage = query
    ? 'Nada encontrado para essa busca.'
    : !canEdit && (datasets?.length ?? 0) === 0
      ? 'Você ainda não tem acesso a nenhum dataset. Peça a um administrador para incluir você (ou o seu time) nos datasets de que precisa.'
      : filter === 'derived'
        ? (canEdit ? 'Nenhum dataset calculado ainda. Crie um com “Novo calculado”.' : 'Nenhum dataset calculado disponível para você.')
        : filter === 'source'
          ? (canEdit ? 'Nenhuma fonte publicada. Publique em Administração › Conexões.' : 'Nenhuma fonte disponível para você.')
          : (canEdit ? 'Nenhum dataset ainda. Publique uma fonte em Conexões ou crie um calculado.' : 'Nenhum dataset disponível para você.')

  const FILTERS = [
    { k: 'all' as const, label: 'Todos', count: counts.all },
    { k: 'source' as const, label: 'Fontes', count: counts.source },
    { k: 'derived' as const, label: 'Calculados', count: counts.derived },
  ]

  return (
    <div className="mx-auto max-w-screen-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Datasets</h1>
          <p className="mt-1 text-sm text-zinc-500">Dados publicados e prontos para explorar — fontes e calculados.</p>
        </div>
        {canEdit && (
          <Link to="/datasets/derived/new"
            className="flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-zinc-950 shadow-card transition-colors hover:bg-accent-hover">
            <Plus size={15} /> Novo calculado
          </Link>
        )}
      </div>

      {/* Filtro Todos / Fontes / Calculados (tudo é dataset). */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(({ k, label, count }) => (
          <button key={k} onClick={() => setFilter(k)}
            className={clsx('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
              filter === k
                ? 'border-accent bg-accent-soft font-semibold text-accent dark:bg-zinc-800'
                : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700')}>
            {k === 'source' && <Database size={14} />}
            {k === 'derived' && <GitMerge size={14} />}
            {label}
            <span className="rounded-full bg-zinc-200/70 px-1.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-700/60">{count}</span>
          </button>
        ))}
        <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar datasets…"
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}
      {datasets === null && !error && <p className="mt-4 text-sm text-zinc-500">Carregando catálogo…</p>}

      {filtered?.length === 0 && (
        <div className="mt-5 flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
            {filter === 'derived' ? <GitMerge size={22} /> : <Boxes size={22} />}
          </div>
          <p className="max-w-md text-sm text-zinc-500">{emptyMessage}</p>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {filtered?.map((d) => <DatasetCard key={d.id} d={d} />)}
      </div>
    </div>
  )
}
