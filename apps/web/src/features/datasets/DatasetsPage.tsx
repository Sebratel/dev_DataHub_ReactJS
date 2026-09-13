// Catálogo de conjuntos — tudo é conjunto: FONTES (ingeridas das origens) e
// CALCULADOS (SQL sobre o lake). O usuário só vê os que pode ler.
//
// Era uma grade de cards; virou tabela densa. Numa grade cabem ~12 conjuntos na
// tela e cada card repete rótulo ("campos", "registros"); numa tabela cabem 25+
// e o rótulo aparece uma vez, no cabeçalho. Com 248 conjuntos a diferença deixa
// de ser estética: comparar frescor entre linhas só funciona em coluna.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, GitMerge, Database, Plus, Layers, BadgeCheck, Clock, CalendarClock } from 'lucide-react'
import type { DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import OfficialBadge from '@/components/OfficialBadge'
import { Page, PageHeader, Toolbar, SearchInput, FilterChips, EmptyState, ErrorBanner, TableSkeleton } from '@/components/ui/Page'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import TierBadge, { tierOf } from '@/components/ui/TierBadge'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import ScheduleAssignDialog from './ScheduleAssignDialog'

function hoursSince(iso: string | null): number | null {
  if (!iso) return null
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000
  return Number.isFinite(h) ? h : null
}
function freshnessLabel(h: number | null): string {
  if (h === null) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}
function freshnessTone(h: number | null): 'ok' | 'warn' | 'crit' | 'neutral' {
  if (h === null) return 'neutral'
  if (h <= 26) return 'ok'
  if (h <= 72) return 'warn'
  return 'crit'
}
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} M`
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} k`
  return n.toLocaleString('pt-BR')
}

type Filter = 'all' | 'source' | 'derived' | 'official'

export default function DatasetsPage() {
  const canEdit = useAuthStore((s) => !!s.user?.roles.some((r) => r === 'admin' || r === 'editor'))
  // Agendamento em lote e' admin (mesma regra do backend em schedulesRouter).
  const isAdmin = useAuthStore((s) => !!s.user?.roles.includes('admin'))
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scheduling, setScheduling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  function load() {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar o catálogo.'))
  }
  useEffect(load, [])

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const stats = useMemo(() => {
    const list = datasets ?? []
    const ages = list.map((d) => hoursSince(d.lastSyncAt)).filter((h): h is number => h !== null).sort((a, b) => a - b)
    return {
      all: list.length,
      source: list.filter((d) => d.kind === 'source').length,
      derived: list.filter((d) => d.kind === 'derived').length,
      official: list.filter((d) => d.official).length,
      rows: list.reduce((s, d) => s + (d.rowCount ?? 0), 0),
      median: ages.length ? ages[Math.floor(ages.length / 2)] : null,
      stale: ages.filter((h) => h > 26).length,
    }
  }, [datasets])

  const filtered = useMemo(() => (datasets ?? [])
    .filter((d) => {
      if (filter === 'source' && d.kind !== 'source') return false
      if (filter === 'derived' && d.kind !== 'derived') return false
      if (filter === 'official' && !d.official) return false
      const q = query.toLowerCase().trim()
      return !q || d.name.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q)
        || d.description.toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q))
    })
    // Oficiais primeiro (fonte de verdade da diretoria), depois por nome.
    .sort((a, b) => Number(b.official) - Number(a.official) || a.name.localeCompare(b.name)),
  [datasets, filter, query])

  // Estado vazio ciente do papel: viewer sem NENHUM acesso recebe orientação
  // clara (o acesso é fechado por padrão), não "nada publicado".
  const emptyMessage = query
    ? 'Nada encontrado para essa busca.'
    : !canEdit && stats.all === 0
      ? 'Você ainda não tem acesso a nenhum conjunto. Peça a um administrador para incluir você (ou o seu time) nos conjuntos de que precisa.'
      : filter === 'derived'
        ? (canEdit ? 'Nenhum conjunto calculado ainda.' : 'Nenhum conjunto calculado disponível para você.')
        : filter === 'source'
          ? (canEdit ? 'Nenhuma fonte publicada. Publique em Conexões.' : 'Nenhuma fonte disponível para você.')
          : filter === 'official'
            ? 'Nenhum conjunto marcado como oficial.'
            : (canEdit ? 'Nenhum conjunto ainda. Publique uma fonte em Conexões ou crie um calculado.' : 'Nenhum conjunto disponível para você.')

  const kpis: Kpi[] = [
    { label: 'Conjuntos', icon: Boxes, value: String(stats.all), foot: `${stats.source} fontes · ${stats.derived} calculados` },
    { label: 'Linhas no lake', icon: Layers, value: compact(stats.rows), foot: 'materializadas em Parquet' },
    {
      label: 'Frescor mediano', icon: Clock,
      value: stats.median !== null ? freshnessLabel(stats.median) : '—',
      foot: stats.stale ? `${stats.stale} atrasado(s)` : 'todos em dia',
    },
    { label: 'Camada ouro', icon: BadgeCheck, value: String(stats.official), foot: 'certificados pela diretoria' },
  ]

  return (
    <Page>
      <PageHeader
        icon={Boxes}
        title="Conjuntos de dados"
        subtitle="Publicados e prontos para explorar — fontes e calculados, sobre o lake."
      >
        {canEdit && (
          <Link
            to="/datasets/derived/new"
            className="flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover active:scale-95"
          >
            <Plus size={14} strokeWidth={2} /> Novo calculado
          </Link>
        )}
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      {datasets === null && !error ? <TableSkeleton /> : (
        <div className="flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          <Toolbar>
            <FilterChips
              value={filter}
              onChange={setFilter}
              options={[
                { key: 'all', label: 'Todos', count: stats.all },
                { key: 'source', label: 'Fontes', count: stats.source, icon: Database },
                { key: 'derived', label: 'Calculados', count: stats.derived, icon: GitMerge },
                { key: 'official', label: 'Oficiais', count: stats.official, icon: BadgeCheck },
              ]}
            />
            <SearchInput value={query} onChange={setQuery} placeholder="Buscar por nome, slug ou etiqueta…" />
            {isAdmin && selected.size > 0 && (
              <button
                onClick={() => setScheduling(true)}
                className="flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover"
              >
                <CalendarClock size={13} /> Agendar atualização ({selected.size})
              </button>
            )}
          </Toolbar>

          <Card>
            <CardHead icon={Boxes} title="Catálogo" sub={`${filtered.length} de ${stats.all}`} />
            {filtered.length === 0 ? (
              <EmptyState
                icon={filter === 'derived' ? GitMerge : Boxes}
                message={emptyMessage}
                action={canEdit && !query ? (
                  <Link to="/datasets/derived/new" className="text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                    Criar um calculado
                  </Link>
                ) : undefined}
              />
            ) : (
              <DataGrid fixed>
                <thead>
                  <tr>
                    {isAdmin && (
                      <Th className="w-[32px]">
                        <input
                          type="checkbox"
                          checked={filtered.length > 0 && filtered.every((d) => selected.has(d.id))}
                          onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((d) => d.id)) : new Set())}
                        />
                      </Th>
                    )}
                    <Th>Conjunto</Th>
                    <Th className="w-[92px]">Camada</Th>
                    <Th className="w-[104px]">Tipo</Th>
                    <Th right className="w-[104px]">Registros</Th>
                    <Th right className="w-[76px]">Campos</Th>
                    <Th className="w-[84px]">Frescor</Th>
                    <Th className="w-[96px]">Estado</Th>
                    <Th className="w-[150px]">Dono</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => {
                    const h = hoursSince(d.lastSyncAt)
                    const tone = freshnessTone(h)
                    return (
                      <Tr key={d.id}>
                        {isAdmin && (
                          <Td onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} />
                          </Td>
                        )}
                        <Td>
                          <Link to={`/datasets/${d.slug}`} className="block hover:text-info dark:hover:text-info-dark">
                            <EntityCell name={d.name} slug={d.description || d.slug}>
                              {d.kind === 'derived'
                                ? <GitMerge size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                                : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
                            </EntityCell>
                          </Link>
                        </Td>
                        <Td><TierBadge tier={tierOf(d.kind, d.official)} /></Td>
                        <Td>
                          <span className="flex items-center gap-1.5">
                            <span className="text-[11.5px] text-zinc-500">
                              {d.kind === 'derived' ? 'calculado' : 'fonte'}
                            </span>
                            {d.official && <OfficialBadge />}
                          </span>
                        </Td>
                        <Td right muted>{d.rowCount !== null ? d.rowCount.toLocaleString('pt-BR') : '—'}</Td>
                        <Td right muted>{d.fieldCount}</Td>
                        <Td muted>{freshnessLabel(h)}</Td>
                        <Td>
                          {tone === 'ok' && <Pill tone="ok">em dia</Pill>}
                          {tone === 'warn' && <Pill tone="warn">atrasado</Pill>}
                          {tone === 'crit' && <Pill tone="crit">parado</Pill>}
                          {tone === 'neutral' && <Pill>sem sync</Pill>}
                        </Td>
                        <Td muted>{d.ownerEmail ? d.ownerEmail.split('@')[0] : '—'}</Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </div>
      )}
      {scheduling && (
        <ScheduleAssignDialog
          datasetIds={[...selected]}
          onClose={() => setScheduling(false)}
          onApplied={() => { setSelected(new Set()); load() }}
        />
      )}
    </Page>
  )
}
