// Painel "Criar com IA" — a pessoa descreve o painel; a IA descobre o conjunto,
// valida no lake e devolve widgets prontos como pré-visualização. Cada proposta
// pode ser adicionada à aba atual (uma a uma ou todas). O mesmo padrão do
// dashboards_IA: o modelo devolve specs declarativas validadas; o app executa.
import { useEffect, useState } from 'react'
import { Sparkles, X, Loader2, Plus, Check, GitMerge } from 'lucide-react'
import type { QueryFilter, Widget, WidgetType, WidgetStyle, DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { currentToken } from '@/store/authProvider'
import WidgetCard from './WidgetCard'

interface WidgetProposal {
  type: WidgetType
  title: string
  datasetSlug: string
  datasetId: string
  dimension: string | null
  metric: Widget['metric']
  filters: QueryFilter[]
  style: WidgetStyle | null
}

const TOOL_LABEL: Record<string, string> = {
  search_datasets: 'Procurando os conjuntos de dados…',
  get_dataset_schema: 'Lendo os campos do conjunto…',
  run_query: 'Validando os dados no lake…',
  propose_widgets: 'Montando os widgets…',
}

interface Props {
  dashboardId: string
  tabId: string
  onClose: () => void
  onAdded: () => void
}

function toWidget(p: WidgetProposal, i: number): Widget {
  return {
    id: `prop-${i}`, tabId: '', title: p.title, type: p.type,
    datasetId: p.datasetId, datasetSlug: p.datasetSlug, dimension: p.dimension,
    metric: p.metric, filters: p.filters ?? [], size: 'md', layout: null, style: p.style, spec: null, sortOrder: i,
  }
}

const SUGGESTIONS = [
  'Um KPI de clientes ativos e um gráfico de clientes por cidade',
  'Chamados por mês (linha) e por status (pizza)',
  'Faturamento por plano, do maior para o menor',
]

export default function AiWidgetPanel({ dashboardId, tabId, onClose, onAdded }: Props) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [proposals, setProposals] = useState<WidgetProposal[]>([])
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [scope, setScope] = useState<string[]>([]) // slugs; vazio = todos

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt))).catch(() => {})
  }, [])

  function toggleScope(slug: string) {
    setScope((s) => s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug])
  }

  async function build() {
    const text = prompt.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    setProgress([])
    setProposals([])
    setSummary('')
    setAdded(new Set())
    try {
      // Passa pela fachada: no modo Firebase o token é renovado sob demanda,
      // então ler o store direto pegaria um valor vencido.
      const token = await currentToken()
      const res = await fetch(`/api/v1/dashboards/${dashboardId}/ai/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: text, datasetSlugs: scope }),
      })
      if (!res.ok || !res.body) {
        throw new Error(((await res.json()) as { error?: string }).error || `Erro ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const raw of events) {
          const eventLine = raw.split('\n').find((l) => l.startsWith('event: '))
          const dataLine = raw.split('\n').find((l) => l.startsWith('data: '))
          if (!eventLine || !dataLine) continue
          const event = eventLine.slice(7).trim()
          const data = JSON.parse(dataLine.slice(6))
          if (event === 'tool') {
            setProgress((p) => [...p, TOOL_LABEL[data.name] ?? `Executando ${data.name}…`])
          } else if (event === 'widgets') {
            setProposals(data as WidgetProposal[])
          } else if (event === 'done') {
            setSummary(data.text ?? '')
            if (data.widgets?.length) setProposals(data.widgets as WidgetProposal[])
          } else if (event === 'error') {
            throw new Error(data.error)
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao construir os widgets.')
    } finally {
      setBusy(false)
    }
  }

  async function add(p: WidgetProposal, i: number) {
    await api(`/api/v1/dashboards/${dashboardId}/widgets`, {
      method: 'POST',
      body: JSON.stringify({
        type: p.type, title: p.title, datasetId: p.datasetId, dimension: p.dimension,
        metric: p.metric, filters: p.filters ?? [], style: p.style, tabId,
      }),
    })
    setAdded((s) => new Set(s).add(i))
    onAdded()
  }

  async function addAll() {
    for (let i = 0; i < proposals.length; i++) {
      if (!added.has(i)) await add(proposals[i], i)
    }
  }

  const remaining = proposals.filter((_, i) => !added.has(i)).length

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="flex items-center gap-2 font-semibold">
            <Sparkles size={17} className="text-accent" /> Criar widgets com IA
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-3.5">
          {/* Escopo: quais conjuntos a IA pode usar nesta tela (vazio = todos). */}
          {datasets.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500">
                  Conjuntos que a IA pode usar {scope.length ? `(${scope.length})` : '(todos)'}
                </span>
                {scope.length > 0 && (
                  <button onClick={() => setScope([])} className="text-[11px] text-zinc-400 hover:text-accent">limpar</button>
                )}
              </div>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {datasets.map((d) => {
                  const on = scope.includes(d.slug)
                  return (
                    <button key={d.slug} onClick={() => toggleScope(d.slug)}
                      className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] ${on ? 'border-accent bg-accent/10 text-accent' : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700'}`}>
                      {d.kind === 'derived' && <GitMerge size={11} />}
                      {d.name}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">Selecione derivados/conjuntos específicos para a IA focar neles — ou deixe vazio para usar todos.</p>
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void build() } }}
            rows={3}
            placeholder="Descreva o painel que você quer. Ex.: um KPI de clientes ativos e um gráfico de chamados por mês."
            className="w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => setPrompt(s)}
                className="rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] text-zinc-500 hover:border-accent hover:text-accent dark:border-zinc-700">
                {s}
              </button>
            ))}
          </div>
          <button onClick={() => void build()} disabled={busy || !prompt.trim()}
            className="mt-3 flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Gerar
          </button>

          {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

          {busy && progress.length > 0 && (
            <div className="mt-4 space-y-1 text-xs text-zinc-500">
              {progress.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {p}
                </div>
              ))}
            </div>
          )}

          {proposals.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">{proposals.length} widget(s) proposto(s)</p>
                {remaining > 0 && (
                  <button onClick={() => void addAll()}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 hover:text-accent dark:border-zinc-700">
                    <Plus size={13} /> Adicionar todos
                  </button>
                )}
              </div>
              {summary && <p className="mb-3 text-xs text-zinc-500">{summary}</p>}
              <div className="grid gap-3">
                {proposals.map((p, i) => (
                  <div key={i} className="rounded-xl border border-zinc-200 p-1 dark:border-zinc-800">
                    <WidgetCard widget={toWidget(p, i)} metrics={[]} editable={false} onDelete={() => {}} />
                    <div className="flex justify-end px-3 pb-2">
                      {added.has(i) ? (
                        <span className="flex items-center gap-1.5 text-xs text-emerald-600"><Check size={13} /> Adicionado</span>
                      ) : (
                        <button onClick={() => void add(p, i)}
                          className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs text-zinc-950 hover:bg-accent-hover">
                          <Plus size={13} /> Adicionar à aba
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
