// Assistente IA — chat estilo ChatGPT sobre o catálogo/lake. A resposta chega
// por SSE: eventos 'tool' viram indicadores de progresso, 'chart' renderiza
// gráficos (mesmo componente dos dashboards) e 'done' traz o texto final.
import { useEffect, useRef, useState } from 'react'
import { Sparkles, Send, Plus, Trash2, Loader2, Search, Database, BarChart3 } from 'lucide-react'
import clsx from 'clsx'
import type { Widget, WidgetType, QueryFilter, Aggregation } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import WidgetCard from '@/features/dashboards/WidgetCard'

interface Conversation { id: string; title: string }
interface ChartDef {
  type: WidgetType; title: string; datasetSlug: string
  dimension: string | null
  metric: { metric: string } | { field: string; agg: Aggregation }
  filters: QueryFilter[]
}
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  charts?: ChartDef[]
  progress?: string[] // indicadores enquanto a IA trabalha
}

const TOOL_LABEL: Record<string, { icon: typeof Search; label: string }> = {
  search_datasets: { icon: Search, label: 'Procurando conjuntos de dados…' },
  get_dataset_schema: { icon: Database, label: 'Lendo os campos do conjunto…' },
  run_query: { icon: Database, label: 'Consultando o lake…' },
  render_chart: { icon: BarChart3, label: 'Montando o gráfico…' },
}

function chartToWidget(c: ChartDef, i: number): Widget {
  return {
    id: `ai-${i}`, title: c.title, type: c.type, datasetId: '', datasetSlug: c.datasetSlug,
    dimension: c.dimension, metric: c.metric, filters: c.filters ?? [], size: 'md', sortOrder: i,
  }
}

export default function AiPage() {
  const user = useAuthStore((s) => s.user)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api<{ conversations: Conversation[] }>('/api/v1/ai/conversations')
      .then((r) => setConversations(r.conversations))
      .catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function openConversation(id: string) {
    setActiveId(id)
    setError(null)
    try {
      const r = await api<{ messages: { id: string; role: 'user' | 'assistant'; content: string; chart: ChartDef[] | null }[] }>(
        `/api/v1/ai/conversations/${id}`,
      )
      setMessages(r.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, charts: m.chart ?? undefined })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar conversa.')
    }
  }

  async function newConversation(): Promise<string | null> {
    try {
      const r = await api<{ id: string; title: string }>('/api/v1/ai/conversations', { method: 'POST' })
      setConversations((c) => [{ id: r.id, title: r.title }, ...c])
      setActiveId(r.id)
      setMessages([])
      return r.id
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar conversa.')
      return null
    }
  }

  async function removeConversation(id: string) {
    if (!window.confirm('Excluir esta conversa?')) return
    await api(`/api/v1/ai/conversations/${id}`, { method: 'DELETE' }).catch(() => {})
    setConversations((c) => c.filter((x) => x.id !== id))
    if (activeId === id) { setActiveId(null); setMessages([]) }
  }

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    let convId = activeId
    if (!convId) {
      convId = await newConversation()
      if (!convId) return
    }
    setInput('')
    setBusy(true)
    setError(null)
    setMessages((m) => [...m, { id: `u-${m.length}`, role: 'user', content: text }])
    const pendingId = `a-pending`
    setMessages((m) => [...m, { id: pendingId, role: 'assistant', content: '', progress: [] }])

    try {
      const token = useAuthStore.getState().accessToken
      const res = await fetch(`/api/v1/ai/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      })
      if (!res.ok || !res.body) {
        throw new Error(((await res.json()) as { error?: string }).error || `Erro ${res.status}`)
      }
      // Parser SSE do stream fetch.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const charts: ChartDef[] = []
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
            const label = TOOL_LABEL[data.name]?.label ?? `Executando ${data.name}…`
            setMessages((m) => m.map((msg) => msg.id === pendingId
              ? { ...msg, progress: [...(msg.progress ?? []), label] } : msg))
          } else if (event === 'chart') {
            charts.push(data as ChartDef)
          } else if (event === 'done') {
            setMessages((m) => m.map((msg) => msg.id === pendingId
              ? { id: data.id, role: 'assistant', content: data.text, charts: data.charts?.length ? data.charts : undefined }
              : msg))
          } else if (event === 'error') {
            throw new Error(data.error)
          }
        }
      }
      // Atualiza o título na lista (primeira mensagem vira título).
      api<{ conversations: Conversation[] }>('/api/v1/ai/conversations')
        .then((r) => setConversations(r.conversations)).catch(() => {})
    } catch (e) {
      setMessages((m) => m.filter((msg) => msg.id !== pendingId))
      setError(e instanceof Error ? e.message : 'Falha ao enviar mensagem.')
    } finally {
      setBusy(false)
    }
  }

  const SUGGESTIONS = [
    'Quais conjuntos de dados estão disponíveis?',
    'Quantos registros tem cada conjunto?',
    'Monte um gráfico de barras com os dados de auditoria por ação.',
  ]

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-6xl gap-4">
      {/* Conversas */}
      <aside className="hidden w-56 shrink-0 flex-col md:flex">
        <button onClick={() => void newConversation()}
          className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover">
          <Plus size={15} /> Nova conversa
        </button>
        <div className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {conversations.map((c) => (
            <div key={c.id}
              className={clsx('group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm',
                activeId === c.id ? 'bg-accent-soft text-accent dark:bg-zinc-800 dark:text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
              <button onClick={() => void openConversation(c.id)} className="min-w-0 flex-1 truncate text-left">
                {c.title}
              </button>
              <button onClick={() => void removeConversation(c.id)}
                className="hidden text-zinc-300 hover:text-red-500 group-hover:block dark:text-zinc-600">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Chat */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-zinc-950">
                <Sparkles size={22} />
              </div>
              <h1 className="mt-4 text-xl font-semibold">Assistente de Dados</h1>
              <p className="mt-1 max-w-md text-sm text-zinc-500">
                Pergunte em linguagem natural, {user?.name.split(' ')[0]} — eu consulto os conjuntos de dados e monto gráficos.
              </p>
              <div className="mt-6 grid gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => setInput(s)}
                    className="rounded-full border border-zinc-200 px-4 py-1.5 text-sm text-zinc-600 hover:border-accent hover:text-accent dark:border-zinc-700 dark:text-zinc-400">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-4 py-4">
            {messages.map((m) => (
              <div key={m.id} className={clsx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={clsx('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
                  m.role === 'user'
                    ? 'bg-accent text-zinc-950'
                    : 'border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900')}>
                  {m.progress && m.content === '' && (
                    <span className="flex flex-col gap-1 text-zinc-500">
                      {m.progress.map((p, i) => (
                        <span key={i} className="flex items-center gap-2 text-xs">
                          {i === m.progress!.length - 1 ? <Loader2 size={12} className="animate-spin" /> : '✓'} {p}
                        </span>
                      ))}
                      {m.progress.length === 0 && <span className="flex items-center gap-2 text-xs"><Loader2 size={12} className="animate-spin" /> Pensando…</span>}
                    </span>
                  )}
                  {m.content && <p className="whitespace-pre-wrap">{m.content}</p>}
                  {m.charts && (
                    <div className="mt-3 grid gap-3">
                      {m.charts.map((c, i) => (
                        <div key={i} className="min-w-[280px]">
                          <WidgetCard widget={chartToWidget(c, i)} metrics={[]} editable={false}
                            onDelete={() => {}} onResize={() => {}} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {error && <p className="mb-2 rounded-lg bg-red-50 p-2.5 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

        <div className="flex items-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            rows={2}
            placeholder="Ex.: quantos eventos de auditoria por ação? Monte um gráfico."
            className="flex-1 resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button onClick={() => void send()} disabled={busy || !input.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}
