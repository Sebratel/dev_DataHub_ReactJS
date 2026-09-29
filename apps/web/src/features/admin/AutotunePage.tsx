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
  Wand2, Loader2, ChevronDown, ChevronRight, AlertTriangle, Check, Ban, RefreshCw, CalendarClock, Lock, Wrench,
} from 'lucide-react'
import type { IncrementalPlan, SyncSchedule } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, ErrorBanner, EmptyState, FilterChips, PrimaryButton } from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill, type Tone } from '@/components/ui/Pill'

type Filter = 'falhando' | 'recarga' | 'todos' | 'alta' | 'revisar' | 'ok' | 'bloqueado'

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

const bytes = (n: number | null) => {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

const duracao = (min: number | null) =>
  min == null ? 'sem estimativa'
    : min < 60 ? `~${min} min`
      : `~${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`

// Resposta do apply em lote. Chega com status 200 (tudo), 207 (parcial) ou
// 422 (nada) — nos três casos com o mesmo corpo, item a item.
interface ApplyResponse {
  applied: number
  requested: number
  results: { datasetId: string; name: string; ok: boolean; error?: string; detached?: boolean }[]
}

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
  // Abre em "não estão atualizando": a pergunta que traz alguém a esta tela
  // quase nunca é "qual a regra ideal?", é "por que esta fonte está parada?".
  const [filter, setFilter] = useState<Filter>('todos')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [reconciling, setReconciling] = useState<string | null>(null)
  const [reloading, setReloading] = useState<string | null>(null)
  const [reloadingLote, setReloadingLote] = useState(false)
  // Relatório da última aplicação. Estado SEPARADO de `error` de propósito:
  // `load()` zera `error` ao reanalisar, e era isso que apagava o resultado
  // antes de ele aparecer.
  const [report, setReport] = useState<ApplyResponse | null>(null)

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
      // Primeiro de todos: quem NÃO está atualizando. Um conjunto que erra em
      // toda execução é mais urgente que um com a regra subótima — e é
      // invisível em qualquer outra tela, porque o erro fica enterrado no
      // histórico de execuções dentro da página do conjunto.
      falhando: all.filter((p) => p.health.failing || p.drift.missing.length > 0),
      // Conjuntos cujo HISTÓRICO ficou errado pelo defeito de fuso e que só uma
      // releitura completa conserta. Ordenados do menor para o maior: numa
      // recarga em série, começar pelos pequenos entrega correção cedo e deixa
      // os caros para uma janela escolhida.
      recarga: all.filter((p) => p.reload.needed)
        .sort((a, b) => (a.reload.lakeBytes ?? 0) - (b.reload.lakeBytes ?? 0)),
      todos: all,
      // "Pronto para aplicar": tem proposta, ainda não está aplicada e o
      // diagnóstico não levantou nenhum risco.
      alta: all.filter((p) => p.proposed && !p.alreadyApplied && p.confidence === 'alta' && !p.warnings.length),
      revisar: all.filter((p) => p.proposed && !p.alreadyApplied && (p.confidence !== 'alta' || p.warnings.length > 0)),
      ok: all.filter((p) => p.alreadyApplied),
      bloqueado: all.filter((p) => !p.proposed),
    }
  }, [plans])

  // Trocar de aba limpa a seleção: entre "aplicar a regra" e "recarregar" o
  // checkbox quer dizer coisas diferentes, e carregar a marcação de uma aba
  // para a outra faria alguém recarregar o que pretendia só padronizar.
  function trocaFiltro(f: Filter) {
    if (f !== filter) setSelected(new Set())
    setFilter(f)
  }

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
    // Pedir cadência fixa a um conjunto que hoje segue um agendamento nomeado
    // TIRA ele do agendamento. É consequência real e some sem aviso.
    const saem = chosen.filter((p) =>
      p.current.cadence === 'schedule' && !(p.proposed?.cadence === 'schedule' && scheduleId)).length

    const ok = await confirm({
      title: `Aplicar a ${ids.length} conjunto(s)`,
      message: [
        minutes && sched
          ? `${minutes} conjunto(s) passam a seguir "${sched.name}" (a cada ${sched.intervalMinutes} min).`
          : minutes
            ? `${minutes} conjunto(s) cabem em cadência de minutos, mas nenhum agendamento foi escolhido — eles ficam de hora em hora.`
            : '',
        saem
          ? `${saem} conjunto(s) DEIXAM o agendamento que seguem hoje e passam a usar a cadência proposta.`
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
    setReport(null)
    try {
      const r = await api<ApplyResponse>(
        '/api/v1/datasets/auto-incremental/apply',
        { method: 'POST', body: JSON.stringify({ datasetIds: ids, scheduleId: scheduleId || null }) },
      )
      // O relatório vai para um estado PRÓPRIO, e não para `error`: o `load()`
      // logo abaixo começa zerando `error`, então a mensagem era apagada antes
      // de a tela desenhá-la. O resultado prático era o pior possível — um lote
      // inteiro recusado pelo banco, e a tela reanalisando em silêncio como se
      // tivesse dado certo.
      setReport(r)
      load()
    } catch (e) {
      // 422 = nada aplicou. O corpo com o detalhe por conjunto vem junto do
      // erro (ver ApiError.body) — é o que permite dizer QUAL falhou e por quê,
      // em vez de só "Erro 422".
      const corpo = e instanceof ApiError ? (e.body as ApplyResponse | undefined) : undefined
      if (corpo?.results) { setReport(corpo); load() }
      else setError(e instanceof Error ? e.message : 'Falha ao aplicar.')
    } finally {
      setApplying(false)
    }
  }

  // Recarga completa: relê a fonte inteira UMA vez e substitui o que está no
  // lake. É a única forma de consertar horário já gravado errado.
  async function reload(p: IncrementalPlan) {
    const ok = await confirm({
      title: `Recarregar "${p.name}"`,
      message:
        `O conjunto será lido INTEIRO da fonte (${num(p.rowCount)} linhas, ${duracao(p.reload.estimatedMinutes)}) ` +
        'e o conteúdo atual do lake será substituído.\n\n' +
        'Roda na fila — uma sincronização por vez no hub inteiro —, então não concorre com as demais, ' +
        'mas ocupa a fila enquanto durar. Durante a carga convivem em disco o Parquet atual, o arquivo ' +
        'temporário e o Parquet novo.\n\n' +
        'Prefira fora do horário de pico, e um de cada vez nos conjuntos grandes.',
      confirmLabel: 'Recarregar',
    })
    if (!ok) return
    setReloading(p.datasetId)
    setError(null)
    try {
      await api(`/api/v1/datasets/${p.datasetId}/reload`, { method: 'POST' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao enfileirar a recarga.')
    } finally {
      setReloading(null)
    }
  }

  // Recarga em LOTE: enfileira vários de uma vez, na ordem em que a lista está
  // (menores primeiro). A fila do hub é sequencial, então elas acontecem uma
  // após a outra — o que se compromete aqui é a fila, não a produção.
  async function reloadBatch() {
    const ids = [...selected]
    if (!ids.length) return
    const escolhidos = groups.recarga.filter((p) => selected.has(p.datasetId))
    const minutos = escolhidos.reduce((a, p) => a + (p.reload.estimatedMinutes ?? 0), 0)
    const semEstimativa = escolhidos.filter((p) => p.reload.estimatedMinutes == null).length

    const ok = await confirm({
      title: `Recarregar ${ids.length} conjunto(s)`,
      message: [
        `Cada um será lido INTEIRO da fonte e substituirá o conteúdo atual no lake.`,
        minutos
          ? `Fila estimada: ${duracao(minutos)}${semEstimativa ? ` (${semEstimativa} sem estimativa)` : ''}. ` +
            'Rodam uma de cada vez — os agendamentos de minutos esperam enquanto isso.'
          : 'Rodam uma de cada vez — os agendamentos de minutos esperam enquanto isso.',
        'Durante cada carga convivem em disco o Parquet atual, o arquivo temporário e o novo. ' +
        'Se a fila for longa, prefira fora do horário de pico.',
      ].join('\n\n'),
      confirmLabel: 'Recarregar',
    })
    if (!ok) return

    setReloadingLote(true)
    setError(null)
    setReport(null)
    try {
      const r = await api<{ queued: number; requested: number; results: ApplyResponse['results'] }>(
        '/api/v1/datasets/reload',
        { method: 'POST', body: JSON.stringify({ datasetIds: ids }) },
      )
      setReport({ applied: r.queued, requested: r.requested, results: r.results })
      load()
    } catch (e) {
      const corpo = e instanceof ApiError ? (e.body as { queued?: number; requested?: number; results?: ApplyResponse['results'] } | undefined) : undefined
      if (corpo?.results) {
        setReport({ applied: corpo.queued ?? 0, requested: corpo.requested ?? ids.length, results: corpo.results })
        load()
      } else setError(e instanceof Error ? e.message : 'Falha ao enfileirar as recargas.')
    } finally {
      setReloadingLote(false)
    }
  }

  // Remove os campos cuja coluna sumiu da fonte. Pede confirmação porque
  // apaga campo publicado — e porque pode zerar a configuração de sync junto,
  // quando o campo removido era chave ou parte da identidade.
  async function reconcile(p: IncrementalPlan) {
    const cols = p.drift.missing.map((m) => m.sourceColumn).join(', ')
    const ok = await confirm({
      title: `Reconciliar "${p.name}" com a fonte`,
      message:
        `Serão removidos ${p.drift.missing.length} campo(s): ${cols}.\n\n` +
        'Essas colunas não existem mais na origem, e é por isso que toda sincronização falha. ' +
        'Se algum deles for a chave incremental ou parte da identidade da linha, essa configuração ' +
        'é zerada junto e a próxima carga recomeça do zero.\n\n' +
        'Confira antes se algum painel, métrica ou conjunto calculado usava esses campos.',
      danger: true,
      confirmLabel: 'Remover e destravar',
    })
    if (!ok) return
    setReconciling(p.datasetId)
    setError(null)
    try {
      const r = await api<{ removed: { sourceColumn: string }[]; clearedConfig: string[] }>(
        `/api/v1/datasets/${p.datasetId}/reconcile-fields`,
        { method: 'POST', body: JSON.stringify({ removeMissing: true }) },
      )
      if (r.clearedConfig.length) {
        setError(`"${p.name}": ${r.removed.length} campo(s) removido(s). Também foi zerado: ${r.clearedConfig.join('; ')}.`)
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao reconciliar.')
    } finally {
      setReconciling(null)
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

      {report && (() => {
        const falhas = report.results.filter((r) => !r.ok)
        const saiu = report.results.filter((r) => r.ok && r.detached).length
        // Agrupa por MOTIVO: num lote de dezenas, a mesma causa costuma
        // derrubar todo mundo, e repetir a mensagem N vezes esconde isso.
        const porMotivo = new Map<string, string[]>()
        for (const f of falhas) {
          const k = f.error ?? 'Motivo não informado.'
          porMotivo.set(k, [...(porMotivo.get(k) ?? []), f.name])
        }
        const tudoOk = falhas.length === 0
        return (
          <div className={`mb-2.5 rounded-2xl border p-3 ${tudoOk
            ? 'border-ok/40 bg-ok-soft dark:bg-ok/10'
            : 'border-crit/40 bg-crit-soft dark:bg-crit/10'}`}>
            <div className="flex items-start gap-2.5">
              {tudoOk
                ? <Check size={14} className="mt-0.5 shrink-0 text-ok dark:text-ok-dark" />
                : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-crit dark:text-crit-dark" />}
              <div className="min-w-0 flex-1">
                <p className={`text-[12px] font-medium ${tudoOk
                  ? 'text-ok dark:text-ok-dark' : 'text-crit dark:text-crit-dark'}`}>
                  {report.applied} de {report.requested} conjunto(s) aplicado(s)
                  {falhas.length > 0 && ` · ${falhas.length} falhou(ram)`}
                </p>
                {saiu > 0 && (
                  <p className="mt-1 text-[11.5px] text-zinc-600 dark:text-zinc-300">
                    {saiu} conjunto(s) deixaram o agendamento que seguiam e passaram à cadência proposta.
                  </p>
                )}
                {[...porMotivo.entries()].map(([motivo, nomes]) => (
                  <div key={motivo} className="mt-2">
                    <p className="text-[11.5px] leading-relaxed text-crit dark:text-crit-dark">{motivo}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {nomes.slice(0, 6).join(', ')}
                      {nomes.length > 6 && ` e mais ${nomes.length - 6}`}
                    </p>
                  </div>
                ))}
              </div>
              <button onClick={() => setReport(null)}
                className="shrink-0 rounded-md px-1.5 text-[11px] text-zinc-500 hover:underline">
                fechar
              </button>
            </div>
          </div>
        )
      })()}

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
          {filter === 'recarga' && (
            <div className="mb-2.5 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                Estes conjuntos vêm de fonte <strong>Postgres</strong> e estão em <strong>incremental</strong>:
                o que já está gravado no lake seguiu 3 horas adiantado, e o corte no futuro pode ter pulado
                linhas. Só uma releitura completa conserta — nova execução normal não reescreve o passado.
                {' '}Conjuntos em <strong>snapshot</strong> e fontes <strong>MySQL</strong> não aparecem aqui:
                os primeiros já se refizeram sozinhos, os segundos nunca foram afetados.
              </p>
              <p className="mt-2 text-[11.5px] text-zinc-500">
                Total: <strong>{groups.recarga.length} conjunto(s)</strong>
                {' · '}{bytes(groups.recarga.reduce((a, p) => a + (p.reload.lakeBytes ?? 0), 0))} no lake
                {' · '}fila estimada{' '}
                {duracao(groups.recarga.reduce((a, p) => a + (p.reload.estimatedMinutes ?? 0), 0) || null)}.
                {' '}Rodam <strong>uma de cada vez</strong>; comece pelos menores.
              </p>
            </div>
          )}

          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <FilterChips<Filter>
              value={filter}
              onChange={trocaFiltro}
              options={[
                { key: 'falhando', label: 'Não estão atualizando', count: groups.falhando.length },
                { key: 'recarga', label: 'Precisam de recarga', count: groups.recarga.length },
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
          {/* A barra é CONTEXTUAL: no filtro de recarga a seleção significa
              "recarregar estes", não "aplicar a regra nestes". Um mesmo
              checkbox com dois significados seria pior que duas barras. */}
          <Card className="mb-2.5">
            {filter === 'recarga' ? (
              <div className="flex flex-wrap items-center gap-3 p-3">
                <button
                  onClick={() => setSelected(new Set(groups.recarga.map((p) => p.datasetId)))}
                  disabled={!isMaster || !groups.recarga.length}
                  className="h-[30px] rounded-lg border border-zinc-200 px-2.5 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Marcar os {groups.recarga.length} que precisam
                </button>
                {/* Os menores primeiro: numa fila sequencial isso entrega
                    correção cedo e deixa os caros para uma janela escolhida. */}
                <button
                  onClick={() => setSelected(new Set(groups.recarga.slice(0, 5).map((p) => p.datasetId)))}
                  disabled={!isMaster || groups.recarga.length < 2}
                  className="h-[30px] rounded-lg border border-zinc-200 px-2.5 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Marcar os 5 menores
                </button>
                {selected.size > 0 && (
                  <button onClick={() => setSelected(new Set())}
                    className="h-[30px] rounded-lg px-2 text-[12px] text-zinc-500 hover:underline">
                    limpar seleção
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-[11.5px] tabular-nums text-zinc-500">
                    {selected.size} marcado(s)
                    {selected.size > 0 && ` · ${duracao(
                      (plans ?? []).filter((p) => selected.has(p.datasetId))
                        .reduce((a, p) => a + (p.reload.estimatedMinutes ?? 0), 0) || null,
                    )} de fila`}
                  </span>
                  <PrimaryButton
                    icon={reloadingLote ? undefined : RefreshCw}
                    onClick={reloadBatch}
                    disabled={!isMaster || !selected.size || reloadingLote}
                    title={isMaster ? undefined : 'Somente o administrador master recarrega uma fonte.'}
                  >
                    {reloadingLote ? <Loader2 size={14} className="animate-spin" /> : null}
                    Recarregar selecionados
                  </PrimaryButton>
                </div>
              </div>
            ) : (
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
            )}
            {filter !== 'recarga' && !schedules.length && (
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
                  const canSelect = filter === 'recarga'
                    ? p.reload.needed
                    : !!p.proposed && !p.alreadyApplied
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
                            {/* Quando foi a última vez que isto atualizou de
                                verdade. É a resposta direta a "por que esta
                                fonte está parada?", e não existia em tela
                                nenhuma — só no histórico dentro do conjunto. */}
                            <p className="truncate text-[11px] text-zinc-500">
                              {p.health.lastSuccessAt
                                ? <>último sucesso: {new Date(p.health.lastSuccessAt).toLocaleString('pt-BR')}</>
                                : <span className="text-crit dark:text-crit-dark">nunca sincronizou com sucesso</span>}
                              {p.health.failing && p.health.failuresSinceSuccess > 0 && (
                                <span className="text-crit dark:text-crit-dark">
                                  {' '}· {p.health.failuresSinceSuccess} falha(s) desde então
                                </span>
                              )}
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
                          {p.health.failing && <Pill tone="crit" dot>Falhando</Pill>}
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
                          {/* Diagnosticar sem oferecer o conserto deixaria a
                              pessoa sabendo do problema e sem saída: o campo
                              com coluna inexistente não podia ser removido por
                              tela nenhuma — só apagando e republicando o
                              conjunto inteiro. */}
                          {p.reload.needed && (
                            <div className="rounded-lg border border-warn/40 bg-warn-soft p-2.5 dark:bg-warn/10">
                              <p className="text-[11.5px] font-medium text-warn dark:text-warn-dark">
                                Precisa de recarga completa
                              </p>
                              <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                                {p.reload.reason}
                              </p>
                              <p className="mt-1 text-[11px] text-zinc-500">
                                {num(p.rowCount)} linhas · {bytes(p.reload.lakeBytes)} no lake ·{' '}
                                {duracao(p.reload.estimatedMinutes)}
                              </p>
                              <button
                                onClick={() => void reload(p)}
                                disabled={!isMaster || reloading === p.datasetId}
                                title={isMaster ? undefined : 'Somente o administrador master recarrega uma fonte.'}
                                className="mt-2 flex h-[28px] items-center gap-1.5 rounded-lg border border-warn/50 px-2.5 text-[11.5px] font-medium text-warn hover:bg-warn/10 disabled:opacity-50 dark:text-warn-dark"
                              >
                                {reloading === p.datasetId
                                  ? <Loader2 size={12} className="animate-spin" />
                                  : <RefreshCw size={12} />}
                                Recarregar tudo
                              </button>
                            </div>
                          )}
                          {p.drift.missing.length > 0 && (
                            <div className="rounded-lg border border-crit/30 bg-crit-soft p-2.5 dark:bg-crit/10">
                              <p className="text-[11.5px] font-medium text-crit dark:text-crit-dark">
                                Campos apontando para colunas que não existem mais
                              </p>
                              <ul className="mt-1 space-y-0.5">
                                {p.drift.missing.map((m) => (
                                  <li key={m.key} className="font-mono text-[11px] text-crit dark:text-crit-dark">
                                    {m.sourceColumn}
                                  </li>
                                ))}
                              </ul>
                              <button
                                onClick={() => void reconcile(p)}
                                disabled={!isMaster || reconciling === p.datasetId}
                                title={isMaster ? undefined : 'Somente o administrador master reconcilia campos de uma fonte.'}
                                className="mt-2 flex h-[28px] items-center gap-1.5 rounded-lg border border-crit/40 px-2.5 text-[11.5px] font-medium text-crit hover:bg-crit/10 disabled:opacity-50 dark:text-crit-dark"
                              >
                                {reconciling === p.datasetId
                                  ? <Loader2 size={12} className="animate-spin" />
                                  : <Wrench size={12} />}
                                Remover esses campos e destravar
                              </button>
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
