// Operar › Qualidade dos dados: a conciliação fonte × lake (D-QLD-3) e as
// verificações contínuas (D-QLD-2).
//
// Existe porque a contagem "oficial" de um conjunto vinha do próprio lake: uma
// linha perdida no caminho só aparecia quando alguém estranhava o número. Os
// doze defeitos de qualidade já corrigidos foram todos achados assim. Aqui o
// sistema confere sozinho — todo dia um conjunto pequeno, um médio e um grande
// — e esta tela mostra o último resultado de cada fonte e os dias que não
// bateram. Os alertas ficam em Saúde da plataforma, junto com os de carga.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ClipboardCheck, Database, RefreshCw, ChevronRight, Loader2, Star, ShieldAlert, GitMerge, Wrench, X,
} from 'lucide-react'
import clsx from 'clsx'
import type {
  QualityOverview, QualityDatasetRow, ReconcileRun, ReconcileBand, DatasetCheckRow,
} from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { hoursSince, lagSince } from '@/lib/freshness'
import {
  Page, PageHeader, ErrorBanner, EmptyState, Toolbar, SearchInput, FilterChips, FilterSelect, TableSkeleton,
} from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { Pill, type Tone } from '@/components/ui/Pill'
import KpiBar from '@/components/ui/KpiBar'

const BAND: Record<ReconcileBand, string> = { small: 'Pequeno', medium: 'Médio', large: 'Grande' }

type Situacao = 'match' | 'diverged' | 'error' | 'pending' | 'never' | 'out'
const SITUACAO: Record<Situacao, { label: string; tone: Tone }> = {
  match: { label: 'bate', tone: 'ok' },
  diverged: { label: 'diverge', tone: 'crit' },
  error: { label: 'não concluída', tone: 'warn' },
  pending: { label: 'conferindo', tone: 'info' },
  never: { label: 'nunca conferido', tone: 'neutral' },
  out: { label: 'fora', tone: 'neutral' },
}

function situacaoDe(d: QualityDatasetRow): Situacao {
  if (d.ineligible) return 'out'
  const s = d.lastRun?.status
  if (!s) return 'never'
  if (s === 'queued' || s === 'running') return 'pending'
  return s
}

const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('pt-BR'))
const fmtDia = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d)
const quando = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—')
// Carimbo da fonte ('AAAA-MM-DD HH:MM…', hora local) → 'DD/MM/AAAA HH:MM'.
const fmtCarimbo = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s)
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : s
}

type Filtro = 'all' | 'diverged' | 'error' | 'match' | 'never' | 'out'

interface Aviso { tone: 'info' | 'ok' | 'warn' | 'crit'; text: string }
const AVISO_CLS: Record<Aviso['tone'], string> = {
  info: 'bg-info-soft text-info dark:bg-info/10 dark:text-info-dark',
  ok: 'bg-ok-soft text-ok dark:bg-ok/10 dark:text-ok-dark',
  warn: 'bg-warn-soft text-warn dark:bg-warn/10 dark:text-warn-dark',
  crit: 'bg-crit-soft text-crit dark:bg-crit/10 dark:text-crit-dark',
}

/** Linhas a mais (+) ou a menos (−) no lake, por extenso. */
function diferencaTxt(run: ReconcileRun): string {
  const dif = (run.lakeRows ?? 0) - (run.sourceRows ?? 0)
  if (dif > 0) return `${fmt(dif)} linha(s) a mais no lake`
  if (dif < 0) return `${fmt(-dif)} linha(s) a menos no lake`
  return `mesmo total, ${fmt(run.daysDiverged)} dia(s) diferentes`
}

// O resultado de uma conferência pedida nesta tela, com o que fazer depois.
function resultadoDe(d: QualityDatasetRow, run: ReconcileRun): Aviso {
  const hora = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
  if (run.status === 'match') {
    return { tone: 'ok', text: `${d.name}: conferido às ${hora} — bate com a fonte (${fmt(run.sourceRows)} linhas).` }
  }
  if (run.status === 'diverged') {
    return {
      tone: 'crit',
      text: `${d.name}: conferido às ${hora} — continua divergente (${diferencaTxt(run)}). ` +
        (run.diagnosis ?? 'Abra a linha para ver os dias que não bateram.'),
    }
  }
  return { tone: 'warn', text: `${d.name}: a conferência não terminou — ${run.error ?? 'motivo não informado'}` }
}

/** Divergente em incremental: a recarga completa é o conserto. */
const corrigivel = (d: QualityDatasetRow) => situacaoDe(d) === 'diverged' && d.mode === 'incremental'

export default function QualityPage() {
  const [data, setData] = useState<QualityOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<Filtro>('all')
  const [faixa, setFaixa] = useState<'all' | ReconcileBand>('all')
  const [query, setQuery] = useState('')
  const [aberto, setAberto] = useState<string | null>(null)
  const [pedindo, setPedindo] = useState<string | null>(null)
  // Um aviso por conjunto pedido nesta tela: o pedido e, depois, o resultado.
  const [avisos, setAvisos] = useState<Record<string, Aviso>>({})
  // Conjuntos cujo resultado esta tela está esperando para anunciar. Sem isto,
  // conferir de novo e receber o MESMO número parecia "não aconteceu nada".
  const acompanhando = useRef(new Set<string>())
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const confirm = useConfirm()

  function load() {
    api<QualityOverview>('/api/v1/quality/overview')
      .then((r) => { setData(r); setError(null) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar a conciliação.'))
  }
  useEffect(load, [])

  // Enquanto alguma conferência espera a fila ou roda, a tela acompanha
  // sozinha — quem clicou "Conciliar agora" vê o resultado chegar.
  const pendente = !!data?.datasets.some((d) => situacaoDe(d) === 'pending')
  useEffect(() => {
    if (!pendente) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [pendente])

  // Terminou uma conferência pedida aqui: diz o resultado com todas as letras.
  useEffect(() => {
    if (!data) return
    for (const d of data.datasets) {
      if (!acompanhando.current.has(d.id) || situacaoDe(d) === 'pending' || !d.lastRun) continue
      acompanhando.current.delete(d.id)
      setAvisos((a) => ({ ...a, [d.id]: resultadoDe(d, d.lastRun!) }))
    }
  }, [data])

  const avisa = (d: QualityDatasetRow, a: Aviso) => setAvisos((cur) => ({ ...cur, [d.id]: a }))
  const fecha = (id: string) => setAvisos((cur) => { const resto = { ...cur }; delete resto[id]; return resto })

  async function conciliar(d: QualityDatasetRow) {
    setPedindo(d.id)
    try {
      const r = await api<{ alreadyQueued: boolean }>(`/api/v1/quality/datasets/${d.id}/reconcile`, { method: 'POST' })
      acompanhando.current.add(d.id)
      avisa(d, {
        tone: 'info',
        text: r.alreadyQueued
          ? `${d.name} já estava na fila de conferência. O resultado aparece aqui quando terminar.`
          : `${d.name} entrou na fila: primeiro a carga, depois a conferência com a fonte. O resultado aparece aqui.`,
      })
      load()
    } catch (e) {
      avisa(d, { tone: 'crit', text: e instanceof Error ? e.message : 'Não foi possível pedir a conciliação.' })
    } finally {
      setPedindo(null)
    }
  }

  // Corrigir = recarga completa + conferência logo depois. Conferir sozinho
  // nunca conserta: linha apagada na fonte, repetida ou faltando no lake só
  // sai com a fonte relida inteira. A recarga entra na fila primeiro; o pedido
  // de conferência pega carona na MESMA carga (a fila não duplica o conjunto)
  // e roda no fim dela, já sobre o lake regravado.
  async function corrigir(d: QualityDatasetRow) {
    const ok = await confirm({
      title: `Corrigir "${d.name}"`,
      message:
        `O conjunto será relido INTEIRO da fonte (${fmt(d.rowCount)} linhas) e o conteúdo atual do lake será ` +
        'substituído. Logo depois, a conferência roda de novo e o resultado aparece aqui.\n\n' +
        'Roda na fila — uma carga por vez no hub inteiro —, então ocupa a fila enquanto durar.' +
        (d.band === 'large' ? ' Conjunto grande: prefira fora do horário de pico.' : ''),
      confirmLabel: 'Recarregar e conferir',
    })
    if (!ok) return
    setPedindo(d.id)
    try {
      await api(`/api/v1/datasets/${d.id}/reload`, { method: 'POST' })
      await api(`/api/v1/quality/datasets/${d.id}/reconcile`, { method: 'POST' })
      acompanhando.current.add(d.id)
      avisa(d, { tone: 'info', text: `${d.name}: recarga completa na fila. Ao terminar, a conferência roda sozinha e o resultado aparece aqui.` })
      load()
    } catch (e) {
      avisa(d, { tone: 'crit', text: e instanceof Error ? e.message : 'Não foi possível pedir a correção.' })
    } finally {
      setPedindo(null)
    }
  }

  const all = data?.datasets ?? []
  const count = (s: Situacao) => all.filter((d) => situacaoDe(d) === s).length
  const elegiveis = all.filter((d) => !d.ineligible)
  const conferidos30 = elegiveis.filter((d) => {
    const h = hoursSince(d.lastRun?.finishedAt ?? null)
    return h != null && h <= 30 * 24
  }).length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((d) => {
      const s = situacaoDe(d)
      return (filtro === 'all' || s === filtro)
        && (faixa === 'all' || d.band === faixa)
        && (!q || d.name.toLowerCase().includes(q) || d.slug.includes(q))
    }).sort((a, b) => {
      // O que precisa de atenção primeiro: diverge, falhou, depois o resto.
      const peso = (d: QualityDatasetRow) => ({ diverged: 0, error: 1, pending: 2, never: 3, match: 4, out: 5 })[situacaoDe(d)]
      return peso(a) - peso(b) || a.name.localeCompare(b.name, 'pt-BR')
    })
  }, [all, filtro, faixa, query])

  const r = data?.rules
  return (
    <Page>
      <PageHeader
        icon={ClipboardCheck}
        title="Qualidade dos dados"
        subtitle={r
          ? `Todo dia, às ${r.reconcileHour}h, o sistema confere com a fonte um conjunto pequeno, um médio e um grande. Divergência ou falha vira alerta.`
          : 'Conciliação fonte × lake e alertas.'}
      />
      {error && <ErrorBanner message={error} onRetry={load} />}

      {data === null && !error ? <TableSkeleton /> : (
        <div className="flex flex-col gap-2.5">
          <KpiBar items={[
            { label: 'Conciliáveis', value: fmt(elegiveis.length), foot: `de ${fmt(all.length)} fontes`, icon: Database },
            { label: 'Conferidos em 30 dias', value: fmt(conferidos30), foot: elegiveis.length ? `${Math.round((conferidos30 / elegiveis.length) * 100)}% dos conciliáveis` : undefined },
            { label: 'Divergem', value: fmt(count('diverged')), foot: 'no último resultado' },
            { label: 'Não concluídas', value: fmt(count('error')), foot: 'fonte fora, tempo esgotado ou carga falhou' },
            { label: 'Verificações falhando', value: fmt(data?.failingChecks.length ?? 0), foot: 'prazo, volume e identidade', icon: ShieldAlert },
          ]} />

          {data && <VerificacoesCard checks={data.failingChecks} />}

          {r && (
            <p className="text-[11px] text-zinc-500">
              Faixas em vigor: pequeno até {fmt(r.smallMaxRows)} linhas · médio até {fmt(r.largeMinRows - 1)} ·
              grande a partir de {fmt(r.largeMinRows)}, que confere só os últimos {r.largeWindowDays} dias.
              Antes de conferir, o conjunto carrega: a comparação é com o lake recém-atualizado.
            </p>
          )}
          {Object.entries(avisos).map(([id, a]) => (
            <p key={id} className={clsx('flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px] leading-relaxed', AVISO_CLS[a.tone])}>
              <span className="min-w-0 flex-1">{a.text}</span>
              <button onClick={() => fecha(id)} aria-label="Fechar aviso" className="shrink-0 opacity-60 hover:opacity-100"><X size={13} /></button>
            </p>
          ))}

          <div>
            <Toolbar>
              <FilterChips<Filtro>
                value={filtro}
                onChange={setFiltro}
                options={[
                  { key: 'all', label: 'Todos', count: all.length },
                  { key: 'diverged', label: 'Divergem', count: count('diverged') },
                  { key: 'error', label: 'Não concluídas', count: count('error') },
                  { key: 'match', label: 'Batem', count: count('match') },
                  { key: 'never', label: 'Nunca conferidos', count: count('never') },
                  { key: 'out', label: 'Fora', count: count('out') },
                ]}
              />
              <FilterSelect<'all' | ReconcileBand>
                label="Faixa"
                value={faixa}
                onChange={setFaixa}
                options={[
                  { key: 'all', label: 'Todas' },
                  ...(['small', 'medium', 'large'] as const).map((b) => ({ key: b, label: BAND[b], count: all.filter((d) => d.band === b).length })),
                ]}
              />
              <SearchInput value={query} onChange={setQuery} placeholder="Buscar conjunto" />
            </Toolbar>

            <Card>
              <CardHead icon={ClipboardCheck} title="Conciliação por conjunto" sub={`${filtered.length} de ${all.length}`} />
              {filtered.length === 0 ? (
                <EmptyState icon={ClipboardCheck} message="Nenhum conjunto com esses filtros." />
              ) : (
                <DataGrid fixed className="min-w-[1080px]">
                  <thead>
                    <tr>
                      <Th className="w-[28px]" />
                      <Th>Conjunto</Th>
                      <Th className="w-[84px]">Faixa</Th>
                      <Th className="w-[200px]">Último resultado</Th>
                      <Th right className="w-[120px]">Fonte</Th>
                      <Th right className="w-[120px]">Lake</Th>
                      <Th right className="w-[96px]" title="Linhas a mais (+) ou a menos (−) no lake">Diferença</Th>
                      <Th className="w-[118px]" title="Dias que não bateram, de quantos comparados">Dias</Th>
                      <Th className="w-[150px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((d) => (
                      <Fragment key={d.id}>
                        <Linha
                          d={d}
                          aberto={aberto === d.id}
                          onToggle={() => setAberto(aberto === d.id ? null : d.id)}
                          pedindo={pedindo === d.id}
                          podeCorrigir={isMaster && corrigivel(d)}
                          onConciliar={() => void conciliar(d)}
                          onCorrigir={() => void corrigir(d)}
                        />
                        {aberto === d.id && (
                          <tr>
                            <td colSpan={9} className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                              <Detalhe d={d} isMaster={isMaster} pedindo={pedindo === d.id}
                                onConciliar={() => void conciliar(d)} onCorrigir={() => void corrigir(d)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </DataGrid>
              )}
            </Card>
          </div>

          <p className="text-[11px] text-zinc-500">
            Divergências e verificações falhando também aparecem em{' '}
            <Link to="/admin/health" className="font-medium text-info hover:underline dark:text-info-dark">Saúde da plataforma</Link>,
            com o histórico de alertas.
          </p>
        </div>
      )}
    </Page>
  )
}

function Linha({ d, aberto, onToggle, pedindo, podeCorrigir, onConciliar, onCorrigir }: {
  d: QualityDatasetRow; aberto: boolean; onToggle: () => void; pedindo: boolean
  podeCorrigir: boolean; onConciliar: () => void; onCorrigir: () => void
}) {
  const s = situacaoDe(d)
  const run = d.lastRun
  const terminou = run && run.status !== 'queued' && run.status !== 'running'
  const dif = terminou && run.sourceRows != null && run.lakeRows != null ? run.lakeRows - run.sourceRows : null
  return (
    <Tr>
      <Td>
        {run && (
          <button onClick={onToggle} aria-label={aberto ? 'Recolher' : 'Ver detalhes'} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            <ChevronRight size={14} className={clsx('transition-transform', aberto && 'rotate-90')} />
          </button>
        )}
      </Td>
      <Td>
        <Link to={`/datasets/${d.slug}`} className="block hover:text-info dark:hover:text-info-dark">
          <EntityCell name={d.name} slug={d.slug}>
            {d.official
              ? <Star size={13} strokeWidth={1.5} className="shrink-0 text-accent" aria-label="Oficial" />
              : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
          </EntityCell>
        </Link>
      </Td>
      <Td muted title={d.rowCount != null ? `${fmt(d.rowCount)} linhas no lake` : undefined}>{BAND[d.band]}</Td>
      <Td title={d.ineligible ?? run?.error ?? (run?.finishedAt ? quando(run.finishedAt) : undefined)}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Pill tone={SITUACAO[s].tone}>{SITUACAO[s].label}</Pill>
          {s === 'out'
            ? <span className="truncate text-[11px] text-zinc-500">{d.ineligible}</span>
            : run && <span className="truncate text-[11px] tabular-nums text-zinc-500">
              {lagSince(hoursSince(run.finishedAt ?? run.createdAt))}{run.trigger === 'daily' ? ' · rotina' : ''}
            </span>}
        </span>
      </Td>
      <Td right mono>{terminou ? fmt(run.sourceRows) : '—'}</Td>
      <Td right mono>{terminou ? fmt(run.lakeRows) : '—'}</Td>
      <Td right mono className={clsx(dif ? 'font-semibold text-crit dark:text-crit-dark' : 'text-zinc-400')}>
        {dif == null ? '—' : dif === 0 ? '0' : `${dif > 0 ? '+' : '−'}${fmt(Math.abs(dif))}`}
      </Td>
      <Td muted>
        {terminou && run.method === 'per-day'
          ? <span className={clsx('tabular-nums', run.daysDiverged ? 'text-crit dark:text-crit-dark' : '')}>
            {fmt(run.daysDiverged)} de {fmt(run.daysCompared)}
          </span>
          : terminou && run.method === 'total' ? <span className="text-[11px]">só o total</span> : '—'}
      </Td>
      <Td>
        {/* Divergente: o botão da linha é o CONSERTO (recarga + conferência).
            "Só conferir de novo" fica no detalhe — conferir não muda o número. */}
        {!d.ineligible && podeCorrigir ? (
          <button
            onClick={onCorrigir}
            disabled={pedindo}
            title="Relê a fonte inteira, substitui o lake e confere de novo"
            className="flex h-[26px] items-center gap-1.5 rounded-lg border border-crit/40 px-2.5 text-[11.5px] font-medium text-crit hover:bg-crit-soft disabled:opacity-50 dark:text-crit-dark dark:hover:bg-crit/10"
          >
            {pedindo ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} strokeWidth={1.8} />}
            Corrigir
          </button>
        ) : !d.ineligible && (
          <button
            onClick={onConciliar}
            disabled={pedindo || s === 'pending'}
            className="flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {s === 'pending' || pedindo
              ? <Loader2 size={12} className="animate-spin" />
              : <RefreshCw size={12} strokeWidth={1.8} />}
            {s === 'pending' ? 'Conferindo…' : 'Conciliar agora'}
          </button>
        )}
      </Td>
    </Tr>
  )
}

// Detalhe de um conjunto: a última conferência por inteiro e as anteriores.
function Detalhe({ d, isMaster, pedindo, onConciliar, onCorrigir }: {
  d: QualityDatasetRow; isMaster: boolean; pedindo: boolean; onConciliar: () => void; onCorrigir: () => void
}) {
  const [runs, setRuns] = useState<ReconcileRun[] | null>(null)
  useEffect(() => {
    api<{ runs: ReconcileRun[] }>(`/api/v1/quality/datasets/${d.id}/reconciliations`)
      .then((r) => setRuns(r.runs)).catch(() => setRuns([]))
  }, [d.id, d.lastRun?.status])
  const run = d.lastRun
  if (!run) return null
  // O limite de baixo de 1900 é técnico (descarta o 0000-00-00 do MySQL):
  // para quem lê, é "desde o início".
  const de = run.windowFrom && !run.windowFrom.startsWith('1900-01-01') ? `de ${fmtCarimbo(run.windowFrom)}` : 'desde o início'
  const janela = run.windowFrom || run.windowTo
    ? `${de} até ${run.windowTo ? fmtCarimbo(run.windowTo) : 'agora'}`
    : 'a tabela inteira'
  return (
    <div className="grid gap-3 text-[11.5px] lg:grid-cols-[1fr_1fr]">
      <div className="min-w-0 space-y-1.5">
        <p className="font-semibold">Última conferência · {quando(run.finishedAt ?? run.createdAt)}</p>
        {run.error && <p className="rounded-lg bg-warn-soft px-2.5 py-1.5 text-warn dark:bg-warn/10 dark:text-warn-dark">{run.error}</p>}
        {run.status === 'diverged' && (
          <div className="rounded-lg border border-crit/30 bg-crit-soft/40 px-2.5 py-2 dark:bg-crit/5">
            <p className="font-semibold text-crit dark:text-crit-dark">Por que diverge · {diferencaTxt(run)}</p>
            <p className="mt-0.5 leading-relaxed text-zinc-700 dark:text-zinc-300">
              {run.diagnosis ?? 'Conferência anterior a este diagnóstico: confira de novo para saber a causa provável.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {corrigivel(d) && (isMaster ? (
                <button onClick={onCorrigir} disabled={pedindo}
                  className="flex h-[26px] items-center gap-1.5 rounded-lg bg-crit px-2.5 text-[11.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  <Wrench size={12} strokeWidth={1.8} /> Recarregar da fonte e conferir
                </button>
              ) : (
                <span className="text-[11px] text-zinc-500">A recarga completa é do admin master.</span>
              ))}
              <button onClick={onConciliar} disabled={pedindo}
                className="flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
                <RefreshCw size={12} strokeWidth={1.8} /> Só conferir de novo
              </button>
            </div>
          </div>
        )}
        <dl className="grid grid-cols-[130px_1fr] gap-x-2 gap-y-1 text-zinc-600 dark:text-zinc-300">
          <dt className="text-zinc-400">Comparação</dt>
          <dd>{run.method === 'per-day' ? `por dia de ${run.keyField?.label ?? '—'}` : run.method === 'total' ? 'total' : '—'}</dd>
          <dt className="text-zinc-400">Janela</dt><dd>{janela}</dd>
          <dt className="text-zinc-400">Soma de controle</dt>
          <dd>{run.sumField
            ? `${run.sumField.label}: fonte ${fmt(run.sourceSum)} × lake ${fmt(run.lakeSum)}`
            : 'sem soma (só contagem)'}</dd>
          {!!run.lostRows && (<>
            <dt className="text-zinc-400">Nunca entram</dt>
            <dd className="text-crit dark:text-crit-dark">{fmt(run.lostRows)} linha(s) da fonte com a chave de carga vazia</dd>
          </>)}
          {run.dupIdentity != null && (<>
            <dt className="text-zinc-400">Identidade na fonte</dt>
            <dd className={run.dupIdentity ? 'text-crit dark:text-crit-dark' : ''}>
              {run.dupIdentity
                ? `não é única: ${fmt(run.dupIdentity)} linha(s) a mais que identidades distintas — a compactação guarda só uma de cada`
                : 'única na janela conferida'}
            </dd>
          </>)}
          {run.lakeDup != null && (<>
            <dt className="text-zinc-400">Repetidas no lake</dt>
            <dd className={run.lakeDup ? 'text-crit dark:text-crit-dark' : ''}>{run.lakeDup ? `${fmt(run.lakeDup)} linha(s)` : 'nenhuma'}</dd>
          </>)}
          {run.sourceMs != null && (<><dt className="text-zinc-400">Tempo na fonte</dt><dd>{fmt(run.sourceMs)} ms</dd></>)}
          <dt className="text-zinc-400">Pedido por</dt><dd>{run.requestedBy ?? '—'}</dd>
        </dl>
        {run.notes.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-zinc-500">
            {run.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        {run.diffDays.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Dias que não bateram ({fmt(run.daysDiverged)})</p>
            <div className="max-h-[200px] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-[11px] tabular-nums">
                <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                  <tr><th className="px-2 py-1 text-left font-medium">Dia</th><th className="px-2 py-1 text-right font-medium">Fonte</th><th className="px-2 py-1 text-right font-medium">Lake</th><th className="px-2 py-1 text-right font-medium">Diferença</th></tr>
                </thead>
                <tbody>
                  {run.diffDays.map((x) => (
                    <tr key={x.day} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-2 py-1">{fmtDia(x.day)}</td>
                      <td className="px-2 py-1 text-right">{fmt(x.sourceRows)}</td>
                      <td className="px-2 py-1 text-right">{fmt(x.lakeRows)}</td>
                      <td className="px-2 py-1 text-right text-crit dark:text-crit-dark">
                        {x.lakeRows === x.sourceRows ? 'soma' : `${x.lakeRows > x.sourceRows ? '+' : '−'}${fmt(Math.abs(x.lakeRows - x.sourceRows))}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div>
          <p className="mb-1 font-semibold">Conferências anteriores</p>
          {runs === null ? <p className="text-zinc-400">Carregando…</p> : (
            <ul className="space-y-0.5">
              {runs.slice(0, 8).map((x) => {
                const s: Situacao = x.status === 'queued' || x.status === 'running' ? 'pending' : x.status
                return (
                  <li key={x.id} className="flex items-center gap-2 tabular-nums text-zinc-500">
                    <Pill tone={SITUACAO[s].tone}>{SITUACAO[s].label}</Pill>
                    <span>{quando(x.finishedAt ?? x.createdAt)}</span>
                    {x.sourceRows != null && <span>· fonte {fmt(x.sourceRows)} × lake {fmt(x.lakeRows)}</span>}
                    <span className="text-zinc-400">· {x.trigger === 'daily' ? 'rotina' : x.requestedBy}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Verificações contínuas (D-QLD-2) ─────────────────────────────────────
// Só o que falha agora: o "ok" é o normal e não precisa de lista. Fontes e
// calculados juntos — o prazo vale para os dois.
const VERIFICACAO: Record<DatasetCheckRow['check'], string> = {
  stale: 'Atrasado',
  volume: 'Volume caiu',
  identity: 'Identidade',
}

function VerificacoesCard({ checks }: { checks: DatasetCheckRow[] }) {
  return (
    <Card>
      <CardHead icon={ShieldAlert} title="Verificações contínuas"
        sub="depois de cada carga (volume, identidade) e a cada 15 min (prazo pela cadência), sem consultar a fonte" />
      {checks.length === 0 ? (
        <EmptyState icon={ShieldAlert} message="Nenhuma verificação falhando: todo conjunto dentro do prazo da cadência, sem queda de volume nem identidade vazia." />
      ) : (
        <DataGrid fixed className="min-w-[900px]">
          <thead>
            <tr>
              <Th>Conjunto</Th>
              <Th className="w-[130px]">Verificação</Th>
              <Th>O que está errado</Th>
              <Th className="w-[130px]">Desde</Th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <Tr key={`${c.datasetId}:${c.check}`}>
                <Td>
                  <Link to={`/datasets/${c.slug}`} className="block hover:text-info dark:hover:text-info-dark">
                    <EntityCell name={c.name} slug={c.slug}>
                      {c.kind === 'derived'
                        ? <GitMerge size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                        : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
                    </EntityCell>
                  </Link>
                </Td>
                <Td><Pill tone={c.check === 'stale' ? 'warn' : 'crit'}>{VERIFICACAO[c.check]}</Pill></Td>
                <Td muted title={c.detail ?? undefined}><span className="line-clamp-2 whitespace-normal text-[11.5px]">{c.detail}</span></Td>
                <Td muted title={quando(c.since)}><span className="tabular-nums text-[11.5px]">{lagSince(hoursSince(c.since))}</span></Td>
              </Tr>
            ))}
          </tbody>
        </DataGrid>
      )}
    </Card>
  )
}
