// ─────────────────────────────────────────────────────────────────────────
// Padronizar atualização: lê o catálogo de cada tabela de origem (chave
// primária, índices únicos, cobertura de índice) e propõe a regra incremental
// de cada conjunto — para aplicar em lote, não um a um na tela do conjunto.
//
// A tela é construída em torno de UMA pergunta: dá para deixar este conjunto
// atualizando de minuto em minuto sem varrer a tabela inteira da produção a
// cada tick? Por isso a coluna mais à direita não é a configuração proposta, e
// sim o AVISO — é ele que decide se a cadência de minutos entra ou não.
//
// Nada é aplicado sozinho: o diagnóstico é só leitura, e o botão de aplicar
// age exclusivamente sobre o que estiver marcado.
// ─────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import {
  Wand2, Loader2, ChevronDown, ChevronRight, AlertTriangle, Check, Ban, RefreshCw, CalendarClock, Lock,
} from 'lucide-react'
import type { IncrementalPlan, SyncSchedule } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, ErrorBanner, EmptyState, FilterChips, PrimaryButton } from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill, type Tone } from '@/components/ui/Pill'

type Filter = 'todos' | 'alta' | 'revisar' | 'ok' | 'bloqueado'

const CONFIDENCE: Record<string, { label: string; tone: Tone }> = {
  alta: { label: 'Confiança alta', tone: 'ok' },
  media: { label: 'Confere antes', tone: 'warn' },
  baixa: { label: 'Precisa de revisão', tone: 'warn' },
}

const CADENCE_LABEL: Record<string, string> = {
  schedule: 'de minuto em minuto',
  hourly: 'de hora em hora',
  daily: 'diária',
  manual: 'manual',
  cascade: 'em cascata',
}

const num = (n: number | null) => (n == null ? '—' : n.toLocaleString('pt-BR'))

// Resumo de uma configuração numa linha só — o que a tabela mostra sem expandir.
function ruleSummary(r: {
  mode: string; incrementalKey: string | null; incrementalKey2: string | null; dedupeKeys: string[]
}): string {
  if (r.mode === 'live') return 'ao vivo (sem lake)'
  if (r.mode !== 'incremental') return 'snapshot (recarrega tudo)'
  const keys = [r.incrementalKey, r.incrementalKey2].filter(Boolean).join(' + ')
  const id = r.dedupeKeys.length ? `identidade ${r.dedupeKeys.join('+')}` : 'SEM identidade'
  return `${keys || 'sem chave'} · ${id}`
}

export default function AutotunePage() {
  const confirm = useConfirm()
  // O DIAGNÓSTICO é aberto a admin: estudar o que precisa mudar e levar pronto
  // ao master vale mais do que esconder a tela. Só o APLICAR é do master —
  // ele grava a regra de atualização de conjuntos de FONTE.
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [plans, setPlans] = useState<IncrementalPlan[] | null>(null)
  const [schedules, setSchedules] = useState<SyncSchedule[]>([])
  const [scheduleId, setScheduleId] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('todos')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)

  function load() {
    setLoading(true)
    setError(null)
    // Uma consulta de catálogo por conjunto, em série (o hub nunca abre várias
    // conexões de uma vez contra a produção) — com dezenas de conjuntos isto
    // leva alguns segundos, daí o estado de carregamento explícito.
    api<{ plans: IncrementalPlan[] }>('/api/v1/datasets/auto-incremental')
      .then((r) => { setPlans(r.plans); setSelected(new Set()) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao analisar os conjuntos.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    api<{ schedules: SyncSchedule[] }>('/api/v1/schedules')
      .then((r) => {
        setSchedules(r.schedules)
        // Pré-seleciona o agendamento de menor intervalo: é o que a tela
        // existe para viabilizar, e evita aplicar sem cadência por esquecimento.
        const fastest = [...r.schedules].sort((a, b) => a.intervalMinutes - b.intervalMinutes)[0]
        if (fastest) setScheduleId(fastest.id)
      })
      .catch(() => { /* sem agendamento, a cadência proposta cai para hora em hora */ })
  }, [])

  const groups = useMemo(() => {
    const all = plans ?? []
    return {
      todos: all,
      // "Pronto para aplicar": tem proposta, ainda não está aplicada e o
      // diagnóstico não levantou nenhum risco.
      alta: all.filter((p) => p.proposed && !p.alreadyApplied && p.confidence === 'alta' && !p.warnings.length),
      revisar: all.filter((p) => p.proposed && !p.alreadyApplied && (p.confidence !== 'alta' || p.warnings.length > 0)),
      ok: all.filter((p) => p.alreadyApplied),
      bloqueado: all.filter((p) => !p.proposed),
    }
  }, [plans])

  const visible = groups[filter]
  const selectable = visible.filter((p) => p.proposed && !p.alreadyApplied)

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  async function apply() {
    const ids = [...selected]
    if (!ids.length) return
    const chosen = (plans ?? []).filter((p) => selected.has(p.datasetId))
    const minutes = chosen.filter((p) => p.proposed?.cadence === 'schedule').length
    const reloads = chosen.filter((p) => p.current.mode !== 'incremental').length
    const sched = schedules.find((s) => s.id === scheduleId)

    const ok = await confirm({
      title: `Aplicar a ${ids.length} conjunto(s)`,
      message: [
        minutes && sched
          ? `${minutes} conjunto(s) passam a seguir "${sched.name}" (a cada ${sched.intervalMinutes} min).`
          : minutes
            ? `${minutes} conjunto(s) cabem em cadência de minutos, mas nenhum agendamento foi escolhido — eles ficam de hora em hora.`
            : '',
        reloads
          ? `${reloads} conjunto(s) mudam de modo: a PRIMEIRA carga lê a tabela inteira uma vez. Prefira aplicar fora do horário de pico.`
          : '',
        'A configuração muda agora; a próxima sincronização é que aplica o efeito no lake.',
      ].filter(Boolean).join('\n\n'),
      confirmLabel: 'Aplicar',
    })
    if (!ok) return

    setApplying(true)
    setError(null)
    try {
      const r = await api<{ applied: number; results: { slug: string; ok: boolean; error?: string }[] }>(
        '/api/v1/datasets/auto-incremental/apply',
        { method: 'POST', body: JSON.stringify({ datasetIds: ids, scheduleId: scheduleId || null }) },
      )
      const falhas = r.results.filter((x) => !x.ok)
      if (falhas.length) {
        setError(`${r.applied} aplicado(s); ${falhas.length} falhou(ram): ` +
          falhas.map((f) => `${f.slug} — ${f.error}`).join(' · '))
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao aplicar.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Page>
      <PageHeader
        icon={Wand2}
        title="Padronizar atualização"
        subtitle="Lê a chave primária, os índices únicos e a cobertura de índice de cada tabela de origem e propõe a regra incremental do conjunto."
      >
        <button
          onClick={load}
          disabled={loading}
          className="flex h-[30px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Reanalisar
        </button>
      </PageHeader>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!isMaster && (
        <div className="mb-2.5 flex items-start gap-2.5 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Lock size={14} className="mt-0.5 shrink-0 text-zinc-400" />
          <p className="text-[12px] leading-relaxed text-zinc-500">
            Você pode <strong>consultar</strong> o diagnóstico à vontade — ele é só leitura do catálogo das
            fontes e não muda nada. <strong>Aplicar</strong> é do administrador master, porque grava a regra
            de atualização de conjuntos de fonte e mexe na carga sobre os bancos de produção.
          </p>
        </div>
      )}

      {plans === null ? (
        <Card><p className="px-3 py-10 text-center text-[12px] text-zinc-500">Lendo o catálogo das fontes…</p></Card>
      ) : (
        <>
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <FilterChips<Filter>
              value={filter}
              onChange={(v) => setFilter(v)}
              options={[
                { key: 'todos', label: 'Todos', count: groups.todos.length },
                { key: 'alta', label: 'Prontos para aplicar', count: groups.alta.length },
                { key: 'revisar', label: 'Conferir antes', count: groups.revisar.length },
                { key: 'ok', label: 'Já padronizados', count: groups.ok.length },
                { key: 'bloqueado', label: 'Sem regra possível', count: groups.bloqueado.length },
              ]}
            />
          </div>

          {/* Barra de ação: escolher a cadência de minutos e aplicar o que está
              marcado. Fica acima da tabela porque a decisão de agendamento vale
              para o lote inteiro, não linha a linha. */}
          <Card className="mb-2.5">
            <div className="flex flex-wrap items-center gap-3 p-3">
              <label className="flex items-center gap-2 text-[12px]">
                <CalendarClock size={14} className="text-zinc-400" />
                <span className="text-zinc-500">Cadência de minutos:</span>
                <select
                  value={scheduleId}
                  onChange={(e) => setScheduleId(e.target.value)}
                  className="h-[30px] rounded-lg border border-zinc-200 bg-white px-2 text-[12px] dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <option value="">nenhum (fica de hora em hora)</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — a cada {s.intervalMinutes} min
                    </option>
                  ))}
                </select>
              </label>

              <button
                onClick={() => setSelected(new Set(groups.alta.map((p) => p.datasetId)))}
                disabled={!isMaster || !groups.alta.length}
                className="h-[30px] rounded-lg border border-zinc-200 px-2.5 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Marcar os {groups.alta.length} prontos
              </button>
              {selected.size > 0 && (
                <button
                  onClick={() => setSelected(new Set())}
                  className="h-[30px] rounded-lg px-2 text-[12px] text-zinc-500 hover:underline"
                >
                  limpar seleção
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11.5px] tabular-nums text-zinc-500">{selected.size} marcado(s)</span>
                <PrimaryButton
                  icon={applying ? undefined : Wand2}
                  onClick={apply}
                  disabled={!isMaster || !selected.size || applying}
                  title={isMaster ? undefined : 'Somente o administrador master aplica a regra nas fontes.'}
                >
                  {applying ? <Loader2 size={14} className="animate-spin" /> : null}
                  Aplicar
                </PrimaryButton>
              </div>
            </div>
            {!schedules.length && (
              <p className="border-t border-zinc-200 px-3 py-2 text-[11.5px] leading-relaxed text-zinc-500 dark:border-zinc-800">
                Nenhum agendamento cadastrado ainda. Sem um agendamento, os conjuntos que caberiam em cadência de
                minutos ficam de hora em hora — crie um em <strong>Agendamentos</strong> e reanalise.
              </p>
            )}
          </Card>

          <Card>
            <CardHead icon={Wand2} title="Conjuntos" sub={`${visible.length}`} />
            {!visible.length ? (
              <EmptyState icon={Check} message="Nada nesta categoria." />
            ) : (
              <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {visible.map((p) => {
                  const isOpen = expanded === p.datasetId
                  const canSelect = !!p.proposed && !p.alreadyApplied
                  const conf = CONFIDENCE[p.confidence]
                  return (
                    <div key={p.datasetId}>
                      <div className="flex items-start gap-2.5 p-3">
                        <input
                          type="checkbox"
                          checked={selected.has(p.datasetId)}
                          onChange={() => toggle(p.datasetId)}
                          disabled={!canSelect || !isMaster}
                          className="mt-1 h-[13px] w-[13px] shrink-0 accent-info disabled:opacity-30"
                          aria-label={`Selecionar ${p.name}`}
                        />
                        <button
                          onClick={() => setExpanded(isOpen ? null : p.datasetId)}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        >
                          {isOpen
                            ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-zinc-400" />
                            : <ChevronRight size={14} className="mt-0.5 shrink-0 text-zinc-400" />}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium">{p.name}</p>
                            <p className="truncate text-[11px] text-zinc-500">
                              {p.connectionId} · {p.schema}.{p.table} · {num(p.rowCount)} linhas
                            </p>
                            <p className="mt-1 text-[11.5px] leading-relaxed">
                              <span className="text-zinc-400">hoje:</span>{' '}
                              <span className="text-zinc-500">{ruleSummary(p.current)}</span>
                              {p.proposed && !p.alreadyApplied && (
                                <>
                                  <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">→</span>
                                  <span className="font-medium text-info dark:text-info-dark">
                                    {ruleSummary(p.proposed)} · {CADENCE_LABEL[p.proposed.cadence]}
                                  </span>
                                </>
                              )}
                            </p>
                          </div>
                        </button>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {p.alreadyApplied
                            ? <Pill tone="ok" dot>Já padronizado</Pill>
                            : !p.proposed
                              ? <Pill tone="crit" dot>Sem regra possível</Pill>
                              : <Pill tone={conf.tone} dot>{conf.label}</Pill>}
                          {p.warnings.length > 0 && (
                            <span className="flex items-center gap-1 text-[10.5px] font-medium text-warn dark:text-warn-dark">
                              <AlertTriangle size={11} />
                              {p.warnings.length} aviso(s)
                            </span>
                          )}
                        </div>
                      </div>

                      {isOpen && (
                        <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/60 px-3 py-3 dark:border-zinc-800/60 dark:bg-zinc-950/40">
                          {p.blocker && (
                            <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-crit dark:text-crit-dark">
                              <Ban size={13} className="mt-0.5 shrink-0" />
                              <p>{p.blocker}</p>
                            </div>
                          )}
                          {p.reasons.length > 0 && (
                            <div>
                              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
                                Por que esta regra
                              </p>
                              <ul className="space-y-1">
                                {p.reasons.map((r, i) => (
                                  <li key={i} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                                    <Check size={12} className="mt-0.5 shrink-0 text-ok dark:text-ok-dark" />
                                    <span>{r}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {p.warnings.length > 0 && (
                            <div>
                              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
                                O que conferir antes
                              </p>
                              <ul className="space-y-1">
                                {p.warnings.map((w, i) => (
                                  <li key={i} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn dark:text-warn-dark" />
                                    <span>{w}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          {selectable.length > 0 && filter !== 'ok' && (
            <p className="mt-2 text-[11px] text-zinc-500">
              Aplicar muda só a configuração. O efeito no lake aparece na próxima sincronização de cada conjunto.
            </p>
          )}
        </>
      )}
    </Page>
  )
}
