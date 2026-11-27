// Operar › IA › Avaliação (27/11/2026): perguntas de negócio com gabarito
// calculado na hora sobre o lake. Diz se o assistente acerta — e se uma troca
// de modelo, de prompt ou de conhecimento melhorou ou piorou. Sem isto,
// "melhorou" é impressão.
import { useCallback, useEffect, useState } from 'react'
import { Play, Loader2, CheckCircle2, XCircle, MinusCircle, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { ErrorBanner } from '@/components/ui/Page'
import Markdown from '@/features/notebooks/markdown'

interface Resultado {
  id: string; tema: string; pergunta: string
  status: 'ok' | 'falhou' | 'pulado' | 'erro'
  esperado?: Record<string, unknown>
  checagens?: { coluna: string; esperado: unknown; ok: boolean }[]
  resposta?: string; motivo?: string
  rodadas?: number; consultas?: number; consultas_com_erro?: number; no_limite?: boolean; ms?: number
}
interface Rodada {
  id: string; started_by: string; started_at: string; finished_at: string | null
  status: 'running' | 'done' | 'error'; provider: string | null; model: string | null
  total: number; passed: number; skipped: number; results: Resultado[]; error: string | null
}
interface Resposta { runs: Rodada[]; emAndamento: string | null; casos: { id: string; tema: string; pergunta: string }[] }

const ICONE = {
  ok: <CheckCircle2 size={14} className="text-emerald-600" />,
  falhou: <XCircle size={14} className="text-red-500" />,
  erro: <AlertTriangle size={14} className="text-amber-500" />,
  pulado: <MinusCircle size={14} className="text-zinc-400" />,
}

const fmtValor = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : String(v))

export default function AiEvalPage() {
  const [dados, setDados] = useState<Resposta | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [iniciando, setIniciando] = useState(false)
  const [escolhida, setEscolhida] = useState<string | null>(null)
  const [aberto, setAberto] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    try {
      const r = await api<Resposta>('/api/v1/ai/eval')
      setDados(r); setErro(null)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar.')
    }
  }, [])

  useEffect(() => { void carregar() }, [carregar])
  // Enquanto roda, atualiza a cada 5 s: cada pergunta leva de 10 s a 1 min.
  useEffect(() => {
    if (!dados?.emAndamento) return
    const t = setInterval(() => void carregar(), 5000)
    return () => clearInterval(t)
  }, [dados?.emAndamento, carregar])

  async function rodar() {
    setIniciando(true); setErro(null)
    try {
      const r = await api<{ id: string }>('/api/v1/ai/eval', { method: 'POST', body: JSON.stringify({}) })
      setEscolhida(r.id)
      await carregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao iniciar.')
    } finally {
      setIniciando(false)
    }
  }

  const rodada = dados?.runs.find((r) => r.id === escolhida) ?? dados?.runs[0] ?? null
  // Placar e lista saem da MESMA fonte (os resultados): o contador da rodada
  // é gravado a cada pergunta e poderia estar um passo atrás da lista.
  const respondidas = rodada ? rodada.results.filter((r) => r.status !== 'pulado').length : 0
  const certas = rodada ? rodada.results.filter((r) => r.status === 'ok').length : 0
  const puladas = rodada ? rodada.results.filter((r) => r.status === 'pulado').length : 0

  return (
    <div className="space-y-4">
      {erro && <ErrorBanner message={erro} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-zinc-500">
          {dados?.casos.length ?? '…'} perguntas reais de negócio. O número certo de cada uma é calculado agora, sobre o
          lake; o assistente responde do zero, e a resposta passa quando traz esse número.
        </p>
        <button onClick={() => void rodar()} disabled={iniciando || !!dados?.emAndamento}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {iniciando || dados?.emAndamento ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {dados?.emAndamento ? 'Rodando…' : 'Rodar avaliação'}
        </button>
      </div>

      {dados && dados.runs.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {dados.runs.map((r) => (
            <button key={r.id} onClick={() => setEscolhida(r.id)}
              className={clsx('rounded-md border px-2 py-1 text-xs tabular-nums',
                r.id === rodada?.id ? 'border-accent text-accent' : 'border-zinc-200 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700')}>
              {new Date(r.started_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · {r.passed}/{r.total - r.skipped}
            </button>
          ))}
        </div>
      )}

      {rodada && (
        <div className="rounded-lg border border-zinc-200 bg-white shadow-card dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <span className="text-2xl font-semibold tabular-nums">
              {respondidas ? Math.round((100 * certas) / respondidas) : 0}%
            </span>
            <span className="text-sm text-zinc-500">
              {certas} de {respondidas} certas{puladas ? ` · ${puladas} pulada${puladas > 1 ? 's' : ''}` : ''}
              {rodada.status === 'running' ? ` · ${rodada.results.length} de ${rodada.total} feitas` : ''}
            </span>
            <span className="text-xs text-zinc-400">{rodada.provider} · {rodada.model} · por {rodada.started_by}</span>
            {rodada.error && <span className="text-xs text-red-500">{rodada.error}</span>}
          </div>
          <ul>
            {rodada.results.map((r) => (
              <li key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <button onClick={() => setAberto(aberto === r.id ? null : r.id)}
                  className="flex w-full items-start gap-2 px-4 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <span className="mt-0.5">{ICONE[r.status]}</span>
                  <span className="min-w-0 flex-1">{r.pergunta}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                    {r.consultas != null ? `${r.consultas} consultas` : ''}{r.ms != null ? ` · ${Math.round(r.ms / 1000)} s` : ''}
                  </span>
                  {aberto === r.id ? <ChevronDown size={14} className="mt-0.5 text-zinc-400" /> : <ChevronRight size={14} className="mt-0.5 text-zinc-400" />}
                </button>
                {aberto === r.id && (
                  <div className="space-y-2 px-10 pb-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {r.motivo && <p className="text-amber-600">{r.motivo}</p>}
                    {r.checagens && (
                      <p>
                        Gabarito:{' '}
                        {r.checagens.map((c) => (
                          <span key={c.coluna} className={clsx('mr-3 font-mono', c.ok ? 'text-emerald-600' : 'text-red-500')}>
                            {c.coluna} = {fmtValor(c.esperado)}
                          </span>
                        ))}
                      </p>
                    )}
                    {r.no_limite && <p className="text-amber-600">Bateu no limite de rodadas ou de tempo.</p>}
                    {r.resposta && (
                      <div className="rounded-md bg-zinc-50 p-2 dark:bg-zinc-900">
                        <Markdown source={r.resposta} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dados && !rodada && <p className="text-sm text-zinc-500">Nenhuma avaliação ainda. Rode a primeira para ter a linha de base.</p>}
    </div>
  )
}
