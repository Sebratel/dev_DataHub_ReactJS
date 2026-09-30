// Catálogo de conjuntos — tudo é conjunto: FONTES (ingeridas das origens) e
// CALCULADOS (SQL sobre o lake). O usuário só vê os que pode ler.
//
// Era uma grade de cards; virou tabela densa. Numa grade cabem ~12 conjuntos na
// tela e cada card repete rótulo ("campos", "registros"); numa tabela cabem 25+
// e o rótulo aparece uma vez, no cabeçalho. Com 248 conjuntos a diferença deixa
// de ser estética: comparar frescor entre linhas só funciona em coluna.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, GitMerge, Database, Plus, Layers, BadgeCheck, Clock, CalendarClock, Server, Zap, Loader2 } from 'lucide-react'
import type { DatasetSummary, DerivedCadenceItem } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import OfficialBadge from '@/components/OfficialBadge'
import { Page, PageHeader, Toolbar, SearchInput, FilterChips, FilterSelect, EmptyState, ErrorBanner, TableSkeleton } from '@/components/ui/Page'
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

// A origem de um conjunto CALCULADO é o próprio lake, não um banco — por isso
// ele fica de fora do filtro de origem e continua em "Calculados".
const ORIGEM_TODAS = '__todas__'

export default function DatasetsPage() {
  const canEdit = useAuthStore((s) => !!s.user?.roles.some((r) => r === 'admin' || r === 'editor'))
  // Agendamento em lote e' admin (mesma regra do backend em schedulesRouter).
  const isAdmin = useAuthStore((s) => !!s.user?.roles.includes('admin'))
  // Aplicar agendamento a um conjunto de FONTE muda como a produção é
  // consultada — do admin master. Se a seleção tiver só calculados, segue
  // liberado para admin (eles rodam sobre o lake, não tocam fonte).
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scheduling, setScheduling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [origem, setOrigem] = useState<string>(ORIGEM_TODAS)
  // Calculados ainda presos a um relógio próprio. Carregado à parte porque a
  // auditoria lê o SQL de cada derivado — não cabe no payload do catálogo.
  const [cadencia, setCadencia] = useState<DerivedCadenceItem[] | null>(null)
  const [trocando, setTrocando] = useState(false)

  function load() {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar o catálogo.'))
  }
  function loadCadencia() {
    if (!canEdit) return
    api<{ items: DerivedCadenceItem[] }>('/api/v1/datasets/derived/cadence-audit')
      .then((r) => setCadencia(r.items))
      .catch(() => { /* auditoria é acessória: sem ela a tela segue inteira */ })
  }
  useEffect(() => { load(); loadCadencia() }, [])

  // Mudar de aba e mudar de origem são a MESMA pergunta vista de dois lados:
  // origem só existe para fonte. Deixar os dois soltos produz combinações que
  // não retornam nada ("Calculados" + "origem ELLEVEN") e parecem defeito.
  function trocaFiltro(f: Filter) {
    setFilter(f)
    if (f === 'derived' || f === 'all') setOrigem(ORIGEM_TODAS)
  }
  function trocaOrigem(o: string) {
    setOrigem(o)
    if (o !== ORIGEM_TODAS && filter !== 'official') setFilter('source')
  }

  const trocaveis = (cadencia ?? []).filter((i) => i.eligible)
  async function trocarParaCascata() {
    setTrocando(true)
    setError(null)
    try {
      await api<{ switched: number }>('/api/v1/datasets/derived/cadence-audit', {
        method: 'POST',
        body: JSON.stringify({ ids: trocaveis.map((i) => i.id) }),
      })
      loadCadencia()
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao trocar a cadência dos calculados.')
    } finally {
      setTrocando(false)
    }
  }

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

  // Origens presentes no catálogo, com quantos conjuntos vêm de cada uma. Sai
  // do próprio payload: o id identifica, o nome é o que se lê. Só aparece
  // origem que tem conjunto — um filtro com opção que não retorna nada mente
  // sobre o que existe no lake.
  const origens = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>()
    for (const d of datasets ?? []) {
      if (d.kind === 'derived' || !d.source) continue
      const cur = m.get(d.source.connectionId)
      if (cur) cur.count++
      else m.set(d.source.connectionId, { name: d.source.connectionName, count: 1 })
    }
    return [...m.entries()]
      .map(([key, v]) => ({ key, label: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [datasets])

  const filtered = useMemo(() => (datasets ?? [])
    .filter((d) => {
      if (filter === 'source' && d.kind !== 'source') return false
      if (filter === 'derived' && d.kind !== 'derived') return false
      if (filter === 'official' && !d.official) return false
      if (origem !== ORIGEM_TODAS && d.source?.connectionId !== origem) return false
      const q = query.toLowerCase().trim()
      return !q || d.name.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q)
        || d.description.toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q))
    })
    // Oficiais primeiro (fonte de verdade da diretoria), depois por nome.
    .sort((a, b) => Number(b.official) - Number(a.official) || a.name.localeCompare(b.name)),
  [datasets, filter, origem, query])

  // Estado vazio ciente do papel: viewer sem NENHUM acesso recebe orientação
  // clara (o acesso é fechado por padrão), não "nada publicado".
  const nomeOrigem = origens.find((o) => o.key === origem)?.label ?? origem
  const emptyMessage = query
    ? 'Nada encontrado para essa busca.'
    : origem !== ORIGEM_TODAS
      ? `Nenhum conjunto de ${nomeOrigem} nesta aba.`
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
              onChange={trocaFiltro}
              options={[
                { key: 'all', label: 'Todos', count: stats.all },
                { key: 'source', label: 'Fontes', count: stats.source, icon: Database },
                { key: 'derived', label: 'Calculados', count: stats.derived, icon: GitMerge },
                { key: 'official', label: 'Oficiais', count: stats.official, icon: BadgeCheck },
              ]}
            />
            {/* De qual banco vem cada fonte. Fica escondido quando a aba é
                "Calculados": ali nenhum conjunto tem origem para filtrar. */}
            {origens.length > 1 && filter !== 'derived' && (
              <FilterSelect
                icon={Server}
                label="Origem"
                value={origem}
                onChange={trocaOrigem}
                options={[{ key: ORIGEM_TODAS, label: 'todas', count: stats.source }, ...origens]}
              />
            )}
            <SearchInput value={query} onChange={setQuery} placeholder="Buscar por nome, slug ou etiqueta…" />
            {isAdmin && selected.size > 0 && (() => {
              const fontes = (datasets ?? []).filter((d) => selected.has(d.id) && d.kind !== 'derived').length
              const travado = fontes > 0 && !isMaster
              return (
                <button
                  onClick={() => setScheduling(true)}
                  disabled={travado}
                  title={travado
                    ? `${fontes} conjunto(s) de fonte na seleção — somente o administrador master agenda a atualização de fontes.`
                    : undefined}
                  className="flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  <CalendarClock size={13} /> Agendar atualização ({selected.size})
                </button>
              )
            })()}
          </Toolbar>

          {/* Cadência dos calculados. Só na aba "Calculados": é ali que a
              pergunta aparece, e um aviso permanente no catálogo inteiro vira
              ruído que ninguém lê depois da segunda vez. */}
          {filter === 'derived' && canEdit && cadencia && trocaveis.length > 0 && (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                <strong>{trocaveis.length} calculado(s) ainda têm relógio próprio</strong> (diária ou de hora
                em hora). Um calculado não lê fonte nenhuma — ele refaz um SQL sobre o lake —, então o relógio
                dele só duplica, e fora de compasso, a frequência de quem ele cita: roda antes da fonte e
                refaz o resultado anterior, ou roda depois e serve dado velho até a hora cheia.
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-500">
                Em <strong>cascata</strong> não há relógio: cada um recalcula quando um conjunto que ele cita
                termina de sincronizar. {trocaveis.slice(0, 4).map((i) => i.name).join(', ')}
                {trocaveis.length > 4 && ` e mais ${trocaveis.length - 4}`}.
              </p>
              <button
                onClick={() => void trocarParaCascata()}
                disabled={trocando}
                className="mt-2.5 flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {trocando ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                Trocar os {trocaveis.length} para cascata
              </button>
            </div>
          )}

          {/* Cascata sem nenhum conjunto citado: não dá erro, não aparece como
              atrasado, e simplesmente para no tempo. É o oposto do aviso acima
              e por isso não some junto com ele. */}
          {filter === 'derived' && canEdit && (cadencia ?? []).some((i) => i.cadence === 'cascade' && !i.dependsOn.length) && (
            <div className="rounded-2xl border border-warn/40 bg-warn-soft p-3 dark:bg-warn/10">
              <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                <strong className="text-warn dark:text-warn-dark">Em cascata, mas sem gatilho.</strong>{' '}
                {(cadencia ?? []).filter((i) => i.cadence === 'cascade' && !i.dependsOn.length)
                  .map((i) => i.name).join(', ')}
                {' '}está(ão) em cascata e o SQL não cita nenhum conjunto do lake — nada dispara esse cálculo,
                e ele não vai atualizar sozinho. Abra cada um e troque para diária ou manual.
              </p>
            </div>
          )}

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
                    {/* Era "Tipo" (fonte/calculado) — o mesmo que o selo de
                        Camada já diz ao lado. Trocado pelo banco de origem,
                        que é a informação que faltava na tabela. */}
                    <Th className="w-[140px]">Origem</Th>
                    <Th right className="w-[104px]">Registros</Th>
                    <Th right className="w-[76px]">Campos</Th>
                    <Th className="w-[84px]">Frescor</Th>
                    <Th className="w-[96px]">Estado</Th>
                    <Th className="w-[126px]">Dono</Th>
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
                            {/* `source` só vem para admin; para leitor sobra o
                                tipo, que é o que ele podia ver antes. */}
                            <span
                              className="truncate text-[11.5px] text-zinc-500"
                              title={d.source ? `${d.source.schema}.${d.source.table}` : undefined}
                            >
                              {d.kind === 'derived'
                                ? 'calculado'
                                : d.source?.connectionName ?? 'fonte'}
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
