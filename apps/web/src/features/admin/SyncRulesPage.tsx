// Administração › Regras de atualização: a regra em vigor de CADA conjunto —
// modo, chaves, identidade, folga e frequência — numa tabela só, com a última
// execução e quantas cargas houve nas últimas 24 h.
//
// Existe porque a regra é gravada em três lugares (o painel do conjunto, os
// Agendamentos e a padronização em lote) e nenhum deles mostrava o quadro de
// todos: para saber quem seguia qual agendamento, ou quem ainda relia a
// tabela inteira a cada execução, era abrir conjunto por conjunto. Aqui só se
// LÊ; editar continua sendo no painel do conjunto, que é para onde cada linha
// leva.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ListChecks, Database, GitMerge } from 'lucide-react'
import type { SyncRuleRow, SyncRuleField } from '@datahub/shared'
import { api } from '@/lib/api'
import { CADENCE_LABEL, scheduleRhythm } from '@/lib/schedules'
import { hoursSince, lagSince } from '@/lib/freshness'
import {
  Page, PageHeader, ErrorBanner, EmptyState, Toolbar, SearchInput, FilterChips, FilterSelect, TableSkeleton,
} from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell, type SortDir } from '@/components/ui/DataGrid'
import { Pill } from '@/components/ui/Pill'

const MODE: Record<string, string> = { snapshot: 'Snapshot', incremental: 'Incremental', live: 'Ao vivo' }

// Rótulo curto para a coluna; o longo (CADENCE_LABEL) é o do painel.
const CADENCE_SHORT: Record<string, string> = {
  daily: 'Diária', hourly: 'De hora em hora', manual: 'Manual', cascade: 'Em cascata',
}

type Kind = 'all' | 'source' | 'derived'
type SortKey = 'name' | 'runs' | 'last'

// A frequência como chave de filtro: a cadência, ou 'sched:<id>'.
const freqKey = (r: SyncRuleRow) => (r.schedule ? `sched:${r.schedule.id}` : r.cadence)

function lagLabel(min: number): string {
  if (!min) return '—'
  return min >= 120 && min % 60 === 0 ? `${min / 60} h` : `${min} min`
}

const labels = (fs: SyncRuleField[]) => fs.map((f) => f.label).join(', ')

export default function SyncRulesPage() {
  const [rows, setRows] = useState<SyncRuleRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('all')
  const [mode, setMode] = useState('all')
  const [freq, setFreq] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })

  function load() {
    setError(null)
    api<{ datasets: SyncRuleRow[] }>('/api/v1/datasets/sync-rules')
      .then((r) => setRows(r.datasets))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar as regras.'))
  }
  useEffect(load, [])

  const all = rows ?? []
  const count = (pred: (r: SyncRuleRow) => boolean) => all.filter(pred).length

  // Opções de frequência a partir do que EXISTE: um agendamento sem conjunto
  // nenhum não ajuda a filtrar, e a lista fica do tamanho da realidade.
  const freqOptions = useMemo(() => {
    const opts: { key: string; label: string; count: number }[] = []
    for (const c of ['daily', 'hourly', 'manual', 'cascade']) {
      const n = all.filter((r) => !r.schedule && r.cadence === c).length
      if (n) opts.push({ key: c, label: CADENCE_SHORT[c], count: n })
    }
    const scheds = new Map<string, { label: string; count: number }>()
    for (const r of all) {
      if (!r.schedule) continue
      const k = `sched:${r.schedule.id}`
      scheds.set(k, { label: r.schedule.name, count: (scheds.get(k)?.count ?? 0) + 1 })
    }
    for (const [key, v] of scheds) opts.push({ key, ...v })
    return [{ key: 'all', label: 'Todas', count: all.length }, ...opts]
  }, [all])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = all.filter((r) =>
      (kind === 'all' || r.kind === kind)
      && (mode === 'all' || (r.kind !== 'derived' && r.mode === mode))
      && (freq === 'all' || freqKey(r) === freq)
      && (!q || [r.name, r.slug, r.table ?? '', r.connectionName ?? ''].some((s) => s.toLowerCase().includes(q))))
    const sign = sort.dir === 'asc' ? 1 : -1
    const lastAt = (r: SyncRuleRow) => (r.lastRun?.startedAt ? new Date(r.lastRun.startedAt).getTime() : 0)
    return out.sort((a, b) => sign * (
      sort.key === 'runs' ? a.runs24h - b.runs24h
        : sort.key === 'last' ? lastAt(a) - lastAt(b)
          : a.name.localeCompare(b.name, 'pt-BR')))
  }, [all, kind, mode, freq, query, sort])

  const th = (key: SortKey) => ({
    active: sort.key === key,
    dir: sort.dir,
    onClick: () => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' })),
  })

  return (
    <Page>
      <PageHeader
        icon={ListChecks}
        title="Regras de atualização"
        subtitle="Como cada conjunto atualiza hoje, numa tabela só. Para mudar a regra de um conjunto, abra-o: tudo se edita no painel dele."
      />
      {error && <ErrorBanner message={error} onRetry={load} />}

      {rows === null && !error ? <TableSkeleton /> : (
        <>
          <Toolbar>
            <FilterChips<Kind>
              value={kind}
              onChange={setKind}
              options={[
                { key: 'all', label: 'Todos', count: all.length },
                { key: 'source', label: 'Fontes', count: count((r) => r.kind === 'source'), icon: Database },
                { key: 'derived', label: 'Calculados', count: count((r) => r.kind === 'derived'), icon: GitMerge },
              ]}
            />
            <FilterSelect
              label="Modo"
              value={mode}
              onChange={setMode}
              options={[
                { key: 'all', label: 'Todos' },
                ...(['incremental', 'snapshot', 'live'] as const).map((m) => ({
                  key: m, label: MODE[m], count: count((r) => r.kind !== 'derived' && r.mode === m),
                })),
              ]}
            />
            <FilterSelect label="Frequência" value={freq} onChange={setFreq} options={freqOptions} />
            <SearchInput value={query} onChange={setQuery} placeholder="Buscar conjunto ou tabela" />
          </Toolbar>

          <Card>
            <CardHead icon={ListChecks} title="Conjuntos" sub={`${filtered.length} de ${all.length}`} />
            {filtered.length === 0 ? (
              <EmptyState icon={ListChecks} message="Nenhum conjunto com esses filtros." />
            ) : (
              <DataGrid fixed className="min-w-[1180px]">
                <thead>
                  <tr>
                    <Th sort={th('name')}>Conjunto</Th>
                    <Th className="w-[96px]">Modo</Th>
                    <Th className="w-[170px]">Chave(s)</Th>
                    <Th className="w-[150px]">Identidade</Th>
                    <Th className="w-[64px]">Folga</Th>
                    <Th className="w-[230px]">Frequência</Th>
                    <Th right sort={th('runs')} className="w-[108px]" title="Execuções iniciadas nas últimas 24 horas">
                      Cargas 24h
                    </Th>
                    <Th sort={th('last')} className="w-[170px]">Última carga</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => <RuleRow key={r.id} r={r} />)}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </>
      )}
    </Page>
  )
}

function RuleRow({ r }: { r: SyncRuleRow }) {
  const derived = r.kind === 'derived'
  const live = !derived && r.mode === 'live'
  const keys = [r.incrementalKey, r.incrementalKey2].filter(Boolean) as SyncRuleField[]
  const run = r.lastRun
  const h = hoursSince(run?.finishedAt ?? run?.startedAt ?? null)

  return (
    <Tr>
      <Td>
        <Link to={`/datasets/${r.slug}`} className="block hover:text-info dark:hover:text-info-dark">
          <EntityCell name={r.name} slug={derived ? 'calculado' : `${r.connectionName ?? ''} · ${r.table ?? ''}`}>
            {derived
              ? <GitMerge size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
              : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
          </EntityCell>
        </Link>
      </Td>
      <Td muted>{derived ? 'SQL no lake' : MODE[r.mode] ?? r.mode}</Td>
      <Td muted title={keys.map((k) => `${k.label} (${k.key})`).join(' + ') || undefined}>
        <span className="block truncate">{keys.length ? keys.map((k) => k.label).join(' + ') : '—'}</span>
      </Td>
      <Td muted title={r.dedupeKeys.length ? labels(r.dedupeKeys) : undefined}>
        <span className="block truncate">
          {r.dedupeKeys.length ? labels(r.dedupeKeys) : r.mode === 'incremental' && !derived ? 'só acrescenta' : '—'}
        </span>
      </Td>
      <Td muted>{r.mode === 'incremental' && !derived ? lagLabel(r.watermarkLagMinutes) : '—'}</Td>
      <Td title={r.schedule ? `${r.schedule.name} — ${scheduleRhythm(r.schedule)}` : CADENCE_LABEL[r.cadence]}>
        {live ? <span className="text-[11.5px] text-zinc-400">não sincroniza</span>
          : r.schedule ? (
            <span className="block min-w-0">
              <span className="block truncate text-[12px] font-medium">{r.schedule.name}</span>
              <span className="block truncate text-[10.5px] text-zinc-400">{scheduleRhythm(r.schedule)}</span>
            </span>
          ) : <span className="text-[11.5px] text-zinc-500">{CADENCE_SHORT[r.cadence] ?? r.cadence}</span>}
      </Td>
      <Td right muted>{r.runs24h.toLocaleString('pt-BR')}</Td>
      <Td title={run?.error ?? r.pausedReason ?? (run?.finishedAt ? new Date(run.finishedAt).toLocaleString('pt-BR') : undefined)}>
        <span className="flex items-center gap-1.5">
          {r.pausedReason ? <Pill tone="crit">pausado</Pill>
            : !run ? <Pill>nunca</Pill>
              : run.status === 'done' ? <Pill tone="ok">ok</Pill>
                : run.status === 'running' ? <Pill tone="info">rodando</Pill>
                  : run.status === 'error' ? <Pill tone="crit">falhou</Pill>
                    : <Pill>{run.status}</Pill>}
          {run && (
            <span className="truncate text-[11px] tabular-nums text-zinc-500">
              {lagSince(h)}{run.status === 'done' && ` · ${run.rows.toLocaleString('pt-BR')} lin.`}
            </span>
          )}
        </span>
      </Td>
    </Tr>
  )
}
