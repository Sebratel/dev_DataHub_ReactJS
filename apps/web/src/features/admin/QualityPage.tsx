// Operar › Qualidade dos dados: a conciliação fonte × lake (D-QLD-3) e o
// canal de alertas.
//
// Existe porque a contagem "oficial" de um conjunto vinha do próprio lake: uma
// linha perdida no caminho só aparecia quando alguém estranhava o número. Os
// doze defeitos de qualidade já corrigidos foram todos achados assim. Aqui o
// sistema confere sozinho — todo dia um conjunto pequeno, um médio e um grande
// — e esta tela mostra o último resultado de cada fonte, os dias que não
// bateram e para onde os alertas vão.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ClipboardCheck, Database, RefreshCw, Bell, BellOff, Send, ChevronRight, Loader2, Star,
} from 'lucide-react'
import clsx from 'clsx'
import type {
  QualityOverview, QualityDatasetRow, ReconcileRun, ReconcileBand, AlertSettingsView, AlertEventRow,
} from '@datahub/shared'
import { api } from '@/lib/api'
import { hoursSince, lagSince } from '@/lib/freshness'
import { useAuthStore } from '@/store/authStore'
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

export default function QualityPage() {
  const [data, setData] = useState<QualityOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<Filtro>('all')
  const [faixa, setFaixa] = useState<'all' | ReconcileBand>('all')
  const [query, setQuery] = useState('')
  const [aberto, setAberto] = useState<string | null>(null)
  const [pedindo, setPedindo] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

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

  async function conciliar(d: QualityDatasetRow) {
    setPedindo(d.id)
    setAviso(null)
    try {
      const r = await api<{ alreadyQueued: boolean }>(`/api/v1/quality/datasets/${d.id}/reconcile`, { method: 'POST' })
      setAviso(r.alreadyQueued
        ? `${d.name} já estava na fila de conferência.`
        : `${d.name} entrou na fila: primeiro a carga, depois a conferência com a fonte.`)
      load()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'Não foi possível pedir a conciliação.')
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
          ]} />

          {r && (
            <p className="text-[11px] text-zinc-500">
              Faixas em vigor: pequeno até {fmt(r.smallMaxRows)} linhas · médio até {fmt(r.largeMinRows - 1)} ·
              grande a partir de {fmt(r.largeMinRows)}, que confere só os últimos {r.largeWindowDays} dias.
              Antes de conferir, o conjunto carrega: a comparação é com o lake recém-atualizado.
            </p>
          )}
          {aviso && <p className="rounded-xl bg-info-soft px-3 py-2 text-[11.5px] text-info dark:bg-info/10 dark:text-info-dark">{aviso}</p>}

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
                          onConciliar={() => void conciliar(d)}
                        />
                        {aberto === d.id && (
                          <tr>
                            <td colSpan={9} className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                              <Detalhe d={d} />
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

          <AlertasCard />
        </div>
      )}
    </Page>
  )
}

function Linha({ d, aberto, onToggle, pedindo, onConciliar }: {
  d: QualityDatasetRow; aberto: boolean; onToggle: () => void; pedindo: boolean; onConciliar: () => void
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
        {!d.ineligible && (
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
function Detalhe({ d }: { d: QualityDatasetRow }) {
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

// ── Canal de alertas ─────────────────────────────────────────────────────
const EVENTO: Record<AlertEventRow['status'], { label: string; tone: Tone }> = {
  sent: { label: 'enviado', tone: 'ok' },
  failed: { label: 'falhou', tone: 'crit' },
  'no-channel': { label: 'sem canal', tone: 'neutral' },
}

function AlertasCard() {
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [settings, setSettings] = useState<AlertSettingsView | null>(null)
  const [events, setEvents] = useState<AlertEventRow[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  function load() {
    api<{ settings: AlertSettingsView; events: AlertEventRow[] }>('/api/v1/quality/alerts')
      .then((r) => { setSettings(r.settings); setEvents(r.events) })
      .catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao carregar os alertas.' }))
  }
  useEffect(load, [])

  async function salvar(body: { webhookUrl?: string; enabled?: boolean }, okText: string) {
    setBusy(true); setMsg(null)
    try {
      const r = await api<{ settings: AlertSettingsView }>('/api/v1/quality/alerts', { method: 'PUT', body: JSON.stringify(body) })
      setSettings(r.settings); setUrl('')
      setMsg({ ok: true, text: okText })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Não foi possível salvar.' })
    } finally { setBusy(false) }
  }

  async function testar() {
    setBusy(true); setMsg(null)
    try {
      await api('/api/v1/quality/alerts/test', { method: 'POST' })
      setMsg({ ok: true, text: 'Mensagem de teste enviada. Confira se chegou no espaço.' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'O teste falhou.' })
    } finally { setBusy(false); load() }
  }

  const inp = 'h-[30px] min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const btn = 'flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'

  return (
    <Card>
      <CardHead icon={Bell} title="Alertas" sub="divergência, conciliação não concluída e carga pausada" />
      <div className="grid gap-4 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-2 text-[11.5px]">
          <p className="text-zinc-500">
            Os avisos vão para um webhook do Google Chat (ou qualquer endereço que receba <code>{'{"text": …}'}</code>, como um fluxo do n8n).
            O mesmo assunto não se repete em 12 h.
          </p>
          {settings && (
            <p className="flex flex-wrap items-center gap-1.5">
              {settings.configured
                ? <Pill tone={settings.enabled ? 'ok' : 'warn'} dot>{settings.enabled ? 'ligado' : 'desligado'}</Pill>
                : <Pill tone="warn" dot>sem canal</Pill>}
              <span className="text-zinc-600 dark:text-zinc-300">
                {settings.configured ? settings.hint : 'Nenhum webhook cadastrado: os alertas ficam só registrados aqui.'}
              </span>
              {settings.lastTestAt && (
                <span className="text-zinc-400">
                  · teste {settings.lastTestOk ? 'ok' : 'falhou'} {lagSince(hoursSince(settings.lastTestAt))}
                </span>
              )}
            </p>
          )}
          {isMaster ? (
            <div className="space-y-2">
              <div className="flex gap-1.5">
                <input
                  id="alert-webhook"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={settings?.configured ? 'Novo endereço (deixe vazio para manter)' : 'https://chat.googleapis.com/v1/spaces/…'}
                  className={inp}
                />
                <button className={btn} disabled={busy || !url.trim()} onClick={() => void salvar({ webhookUrl: url.trim() }, 'Webhook salvo. Use "Testar" para conferir.')}>
                  Salvar
                </button>
              </div>
              {settings?.configured && (
                <div className="flex flex-wrap gap-1.5">
                  <button className={btn} disabled={busy} onClick={() => void testar()}>
                    <Send size={12} strokeWidth={1.8} /> Testar
                  </button>
                  <button className={btn} disabled={busy}
                    onClick={() => void salvar({ enabled: !settings.enabled }, settings.enabled ? 'Alertas desligados.' : 'Alertas ligados.')}>
                    {settings.enabled ? <BellOff size={12} strokeWidth={1.8} /> : <Bell size={12} strokeWidth={1.8} />}
                    {settings.enabled ? 'Desligar' : 'Ligar'}
                  </button>
                  <button className={clsx(btn, 'text-crit dark:text-crit-dark')} disabled={busy}
                    onClick={() => void salvar({ webhookUrl: '' }, 'Webhook removido.')}>
                    Remover
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-zinc-400">Só o admin master altera o canal de alertas.</p>
          )}
          {msg && <p className={msg.ok ? 'text-ok dark:text-ok-dark' : 'text-crit dark:text-crit-dark'}>{msg.text}</p>}
        </div>

        <div className="min-w-0">
          <p className="mb-1 text-[11.5px] font-semibold">Últimos alertas</p>
          {events.length === 0 ? (
            <p className="text-[11.5px] text-zinc-400">Nenhum alerta até agora.</p>
          ) : (
            <ul className="max-h-[260px] space-y-1.5 overflow-auto pr-1">
              {events.slice(0, 20).map((e) => (
                <li key={e.id} className="rounded-lg border border-zinc-100 px-2.5 py-1.5 dark:border-zinc-800">
                  <div className="flex items-center gap-1.5">
                    <Pill tone={EVENTO[e.status].tone}>{EVENTO[e.status].label}</Pill>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{e.title}</span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{lagSince(hoursSince(e.createdAt))}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-line text-[11px] text-zinc-500">{e.body}</p>
                  {e.error && <p className="mt-0.5 text-[11px] text-crit dark:text-crit-dark">{e.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}
