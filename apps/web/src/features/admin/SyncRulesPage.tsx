// Operar › Regras de atualização: a regra em vigor de CADA conjunto — modo,
// chaves, identidade, folga e frequência — numa tabela só, com a última
// execução e quantas cargas houve nas últimas 24 h. Em cima, os agendamentos.
//
// Existe porque a regra é gravada em três lugares (o painel do conjunto, os
// agendamentos e a padronização em lote) e nenhum deles mostrava o quadro de
// todos. A regra de UM conjunto continua sendo editada no painel dele, que é
// para onde cada linha leva.
//
// Os agendamentos moravam numa tela à parte, com a lista de quem segue cada
// um. Essa lista era a mesma tabela daqui filtrada pela frequência, então a
// tela virou a faixa de cartões do topo: clicar num cartão filtra a tabela, e
// é na tabela filtrada que se tira um conjunto do agendamento.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  ListChecks, Database, GitMerge, CalendarClock, Lock, Pencil, Plus, Trash2, Loader2, X,
} from 'lucide-react'
import type { SyncRuleRow, SyncRuleField, SyncSchedule } from '@datahub/shared'
import { api } from '@/lib/api'
import { CADENCE_LABEL, scheduleRhythm } from '@/lib/schedules'
import { hoursSince, lagSince } from '@/lib/freshness'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import {
  Page, PageHeader, ErrorBanner, EmptyState, Toolbar, SearchInput, FilterChips, FilterSelect, TableSkeleton,
} from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell, type SortDir } from '@/components/ui/DataGrid'
import { Pill } from '@/components/ui/Pill'
import ScheduleDialog from './ScheduleDialog'

const MODE: Record<string, string> = { snapshot: 'Snapshot', incremental: 'Incremental', live: 'Ao vivo' }

// Rótulo curto para a coluna; o longo (CADENCE_LABEL) é o do painel.
const CADENCE_SHORT: Record<string, string> = {
  daily: 'Diária', hourly: 'De hora em hora', manual: 'Manual', cascade: 'Em cascata',
}

type Kind = 'all' | 'source' | 'derived'
type SortKey = 'name' | 'runs' | 'last'

const SCHED = 'sched:'
// A frequência como chave de filtro: a cadência, ou 'sched:<id>'.
const freqKey = (r: SyncRuleRow) => (r.schedule ? `${SCHED}${r.schedule.id}` : r.cadence)

function lagLabel(min: number): string {
  if (!min) return '—'
  return min >= 120 && min % 60 === 0 ? `${min / 60} h` : `${min} min`
}

const labels = (fs: SyncRuleField[]) => fs.map((f) => f.label).join(', ')
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

export default function SyncRulesPage() {
  const confirm = useConfirm()
  // Mexer num agendamento que rege conjunto de FONTE é mudar como a produção é
  // consultada: só o admin master. O backend trava igual (masterGuard.ts); aqui
  // a trava aparece antes do clique, em vez de virar 403 depois.
  const isMaster = useAuthStore((st) => !!st.user?.master)
  const [rows, setRows] = useState<SyncRuleRow[] | null>(null)
  const [schedules, setSchedules] = useState<SyncSchedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [schedError, setSchedError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('all')
  const [mode, setMode] = useState('all')
  const [freq, setFreq] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [editing, setEditing] = useState<SyncSchedule | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  function load() {
    setError(null)
    setSchedError(null)
    api<{ datasets: SyncRuleRow[] }>('/api/v1/datasets/sync-rules')
      .then((r) => setRows(r.datasets))
      .catch((e) => setError(errMsg(e, 'Falha ao carregar as regras.')))
    // Separado: a tabela de regras não depende da lista de agendamentos, e
    // uma falha aqui não deve esconder a outra.
    api<{ schedules: SyncSchedule[] }>('/api/v1/schedules')
      .then((r) => setSchedules(r.schedules))
      .catch((e) => setSchedError(errMsg(e, 'Falha ao carregar os agendamentos.')))
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
      const k = `${SCHED}${r.schedule.id}`
      scheds.set(k, { label: r.schedule.name, count: (scheds.get(k)?.count ?? 0) + 1 })
    }
    for (const [key, v] of scheds) opts.push({ key, ...v })
    return [{ key: 'all', label: 'Todas', count: all.length }, ...opts]
  }, [all])

  // Tirar o último conjunto de um agendamento (ou apagá-lo) some com a opção
  // do filtro; aí o filtro volta para "Todas" em vez de esvaziar a tabela.
  const freqAtual = freqOptions.some((o) => o.key === freq) ? freq : 'all'
  const schedAtivo = freqAtual.startsWith(SCHED) ? freqAtual.slice(SCHED.length) : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = all.filter((r) =>
      (kind === 'all' || r.kind === kind)
      && (mode === 'all' || (r.kind !== 'derived' && r.mode === mode))
      && (freqAtual === 'all' || freqKey(r) === freqAtual)
      && (!q || [r.name, r.slug, r.table ?? '', r.connectionName ?? ''].some((s) => s.toLowerCase().includes(q))))
    const sign = sort.dir === 'asc' ? 1 : -1
    const lastAt = (r: SyncRuleRow) => (r.lastRun?.startedAt ? new Date(r.lastRun.startedAt).getTime() : 0)
    return out.sort((a, b) => sign * (
      sort.key === 'runs' ? a.runs24h - b.runs24h
        : sort.key === 'last' ? lastAt(a) - lastAt(b)
          : a.name.localeCompare(b.name, 'pt-BR')))
  }, [all, kind, mode, freqAtual, query, sort])

  const th = (key: SortKey) => ({
    active: sort.key === key,
    dir: sort.dir,
    onClick: () => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' })),
  })

  // Cartão → tabela: mostra quem segue o agendamento. Os outros filtros saem
  // do caminho, senão "Ver os 4 conjuntos" poderia mostrar só 1.
  function mostrar(s: SyncSchedule) {
    if (schedAtivo === s.id) { setFreq('all'); return }
    setKind('all'); setMode('all'); setQuery('')
    setFreq(`${SCHED}${s.id}`)
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function remove(s: SyncSchedule) {
    const ok = await confirm({
      title: 'Excluir agendamento',
      message: s.datasetCount
        ? `"${s.name}" é seguido por ${s.datasetCount} conjunto(s). Eles voltam para a cadência diária. Não dá para desfazer.`
        : `"${s.name}" será excluído. Não dá para desfazer.`,
      danger: true, confirmLabel: 'Excluir',
    })
    if (!ok) return
    setBusyId(s.id)
    try {
      await api(`/api/v1/schedules/${s.id}?force=true`, { method: 'DELETE' })
      load()
    } catch (e) {
      setSchedError(errMsg(e, 'Falha ao excluir.'))
    } finally {
      setBusyId(null)
    }
  }

  async function unassign(r: SyncRuleRow) {
    const ok = await confirm({
      title: 'Tirar do agendamento',
      message: `"${r.name}" deixa de seguir "${r.schedule?.name}" e volta para a cadência diária.`,
      confirmLabel: 'Tirar',
    })
    if (!ok) return
    setBusyId(r.id)
    try {
      await api('/api/v1/schedules/unassign', { method: 'POST', body: JSON.stringify({ datasetIds: [r.id] }) })
      load()
    } catch (e) {
      setError(errMsg(e, 'Falha ao tirar do agendamento.'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Page>
      <PageHeader
        icon={ListChecks}
        title="Regras de atualização"
        subtitle="Como cada conjunto atualiza hoje e os agendamentos que eles seguem. A regra de um conjunto se muda no painel dele; o horário de um agendamento, aqui."
      />
      {error && <ErrorBanner message={error} onRetry={load} />}

      <SchedulesCard
        schedules={schedules}
        error={schedError}
        isMaster={isMaster}
        activeId={schedAtivo}
        busyId={busyId}
        onNew={() => setEditing('new')}
        onShow={mostrar}
        onEdit={setEditing}
        onRemove={(s) => void remove(s)}
      />

      <div ref={tableRef} className="scroll-mt-3">
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
              <FilterSelect label="Frequência" value={freqAtual} onChange={setFreq} options={freqOptions} />
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
                    {filtered.map((r) => (
                      <RuleRow
                        key={r.id}
                        r={r}
                        busy={busyId === r.id}
                        // O "tirar" só aparece com a tabela filtrada por um
                        // agendamento: é a lista de membros que a tela antiga
                        // abria, no mesmo lugar onde o resto da regra está.
                        unassign={schedAtivo && r.schedule ? {
                          locked: r.kind !== 'derived' && !isMaster,
                          onClick: () => void unassign(r),
                        } : undefined}
                      />
                    ))}
                  </tbody>
                </DataGrid>
              )}
            </Card>
          </>
        )}
      </div>

      {editing && (
        <ScheduleDialog
          schedule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </Page>
  )
}

const ICON_BTN = 'rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
const ICON_BTN_DANGER = 'rounded-md p-1.5 text-zinc-400 hover:bg-crit-soft hover:text-crit disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-crit/10 dark:hover:text-crit-dark'

function SchedulesCard({ schedules, error, isMaster, activeId, busyId, onNew, onShow, onEdit, onRemove }: {
  schedules: SyncSchedule[] | null
  error: string | null
  isMaster: boolean
  activeId: string | null
  busyId: string | null
  onNew: () => void
  onShow: (s: SyncSchedule) => void
  onEdit: (s: SyncSchedule) => void
  onRemove: (s: SyncSchedule) => void
}) {
  return (
    <Card className="mb-3">
      <CardHead
        icon={CalendarClock}
        title="Agendamentos"
        sub={schedules?.length ? 'janela de horário + intervalo, seguidos por vários conjuntos de uma vez' : undefined}
      >
        <button onClick={onNew}
          className="flex h-[26px] items-center gap-1 rounded-lg border border-zinc-200 px-2 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          <Plus size={12} strokeWidth={2} /> Novo agendamento
        </button>
      </CardHead>
      {error ? (
        <p className="px-3 py-3 text-[12px] text-crit dark:text-crit-dark">{error}</p>
      ) : schedules === null ? (
        <p className="px-3 py-3 text-[12px] text-zinc-500">Carregando…</p>
      ) : schedules.length === 0 ? (
        <p className="px-3 py-3 text-[12px] leading-relaxed text-zinc-500">
          Nenhum agendamento. Um agendamento é uma janela de horário com intervalo em minutos — por exemplo, a cada
          15 min das 07:00 às 19:00, seg–sex — que vários conjuntos seguem juntos.
        </p>
      ) : (
        <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {schedules.map((s) => {
            const n = s.datasetCount ?? 0
            // sourceCount vem da API; na falta dela, tratar todo membro como
            // fonte é o lado seguro do erro.
            const fontes = s.sourceCount ?? n
            const travado = fontes > 0 && !isMaster
            const motivo = `Este agendamento rege ${fontes} conjunto(s) de fonte — somente o administrador master pode alterá-lo.`
            const ativo = activeId === s.id
            return (
              <div key={s.id} className={clsx(
                'flex items-start gap-2 rounded-xl border px-3 py-2.5 transition-colors',
                ativo ? 'border-accent bg-accent-soft dark:bg-zinc-800/60' : 'border-zinc-200 dark:border-zinc-800',
              )}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium" title={s.name}>{s.name}</p>
                  <p className="truncate text-[11px] text-zinc-500" title={scheduleRhythm(s)}>{scheduleRhythm(s)}</p>
                  {n > 0 ? (
                    <button onClick={() => onShow(s)}
                      className="mt-1 text-[11px] font-medium text-info hover:underline dark:text-info-dark">
                      {ativo ? 'Mostrar todos os conjuntos' : n === 1 ? 'Ver o conjunto na tabela' : `Ver os ${n} conjuntos na tabela`}
                    </button>
                  ) : (
                    <p className="mt-1 text-[11px] text-zinc-400">Nenhum conjunto segue este agendamento.</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {busyId === s.id && <Loader2 size={13} className="mr-1 animate-spin text-zinc-400" />}
                  {travado && <Lock size={12} className="mr-1 shrink-0 text-zinc-400" aria-label={motivo} />}
                  <button onClick={() => onEdit(s)} disabled={travado} title={travado ? motivo : 'Editar'} aria-label="Editar"
                    className={ICON_BTN}>
                    <Pencil size={13} strokeWidth={1.6} />
                  </button>
                  <button onClick={() => onRemove(s)} disabled={travado || busyId === s.id} title={travado ? motivo : 'Excluir'}
                    aria-label="Excluir" className={ICON_BTN_DANGER}>
                    <Trash2 size={13} strokeWidth={1.6} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function RuleRow({ r, busy, unassign }: {
  r: SyncRuleRow
  busy: boolean
  unassign?: { locked: boolean; onClick: () => void }
}) {
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
            <span className="flex min-w-0 items-center gap-1">
              <span className="block min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{r.schedule.name}</span>
                <span className="block truncate text-[10.5px] text-zinc-400">{scheduleRhythm(r.schedule)}</span>
              </span>
              {unassign && (busy
                ? <Loader2 size={13} className="shrink-0 animate-spin text-zinc-400" />
                : (
                  <button onClick={unassign.onClick} disabled={unassign.locked}
                    title={unassign.locked
                      ? 'Somente o administrador master tira um conjunto de fonte do agendamento.'
                      : 'Tirar deste agendamento (volta para a cadência diária)'}
                    aria-label="Tirar deste agendamento"
                    className="shrink-0 rounded-md p-1 text-zinc-300 hover:bg-crit-soft hover:text-crit disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300 dark:text-zinc-600 dark:hover:bg-crit/10">
                    <X size={13} />
                  </button>
                ))}
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
