// A fila de sincronização: o que roda agora, o que espera e o que acabou.
//
// Existe por causa de uma pergunta simples que não tinha resposta: depois de
// mandar recarregar uma dúzia de conjuntos, onde se acompanha? O histórico mora
// DENTRO da página de cada conjunto, e o que ainda nem começou não aparecia em
// lugar nenhum — restava abrir um por um e adivinhar a ordem.
//
// As sincronizações rodam UMA DE CADA VEZ no hub inteiro, então "o que está
// rodando" é quase sempre uma linha só, e a fila é o resto. É essa forma que o
// card mostra: a de cima é agora, as de baixo são a espera.
import { useEffect, useState } from 'react'
import { Loader2, Check, X, Clock, GitMerge } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardHead } from '@/components/ui/Card'

interface Fila {
  running: { datasetId: string; name: string; kind: string; mode: string; rows: number; startedAt: string }[]
  pending: { datasetId: string; name: string; kind: string }[]
  recent: {
    datasetId: string; name: string; kind: string; mode: string; status: string
    rows: number; error: string | null; finishedAt: string | null
  }[]
}

// Conjunto CALCULADO na fila não é engano: ele roda SQL sobre o lake e disputa
// a mesma fila sequencial das fontes. Esconder faria a fila mentir sobre por
// que os outros esperam — mas sem a marca é difícil saber o que a linha faz ali.
const Calculado = () => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-[10px] text-zinc-400"
    title="Conjunto calculado: roda SQL sobre o lake, não lê da fonte">
    <GitMerge size={10} /> calculado
  </span>
)

const hora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'

// Acima de dois dias a unidade vira DIAS. "1384h45" é tecnicamente correto e
// praticamente ilegível — some no meio dos outros números em vez de gritar que
// há algo errado. Uma execução de "57 dias" se denuncia sozinha.
function decorrido(desde: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(desde).getTime()) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)} dias`
}

export default function SyncQueueCard() {
  const [fila, setFila] = useState<Fila | null>(null)
  const [tirando, setTirando] = useState(false)

  const carregarAgora = () =>
    api<Fila>('/api/v1/datasets/sync-queue').then(setFila).catch(() => { /* acessório */ })

  // Tira da fila quem ainda não começou. Não interrompe o que já está rodando —
  // para isso existe "Parar", na tela do conjunto.
  async function tirarDaFila(ids?: string[]) {
    setTirando(true)
    try {
      await api('/api/v1/datasets/sync-queue/cancel', {
        method: 'POST', body: JSON.stringify({ datasetIds: ids ?? [] }),
      })
      await carregarAgora()
    } catch { /* o próximo poll mostra o estado real */ } finally { setTirando(false) }
  }

  useEffect(() => {
    let vivo = true
    const carregar = () => {
      api<Fila>('/api/v1/datasets/sync-queue')
        .then((r) => { if (vivo) setFila(r) })
        .catch(() => { /* card é acessório: falha não atrapalha a tela */ })
    }
    carregar()
    // 5s: rápido o bastante para parecer ao vivo, leve o bastante para ficar
    // aberto a tarde inteira enquanto uma recarga longa roda.
    const t = setInterval(carregar, 5000)
    return () => { vivo = false; clearInterval(t) }
  }, [])

  if (!fila) return null
  const { running, pending, recent } = fila
  // Nada rodando e nada esperando: o card não tem o que dizer, e ocupar espaço
  // no topo da tela com "nenhuma sincronização" seria ruído permanente.
  if (!running.length && !pending.length) return null

  return (
    <Card className="mb-2.5">
      <CardHead
        icon={Loader2}
        title="Fila de sincronização"
        sub={`${running.length} rodando · ${pending.length} na espera`}
      >
        {pending.length > 0 && (
          <button
            onClick={() => void tirarDaFila()}
            disabled={tirando}
            className="text-[11px] font-medium text-zinc-500 hover:text-crit hover:underline disabled:opacity-50 dark:hover:text-crit-dark"
            title="Tira da fila tudo que ainda não começou. O que está rodando continua."
          >
            esvaziar a espera
          </button>
        )}
        <span className="text-[10.5px] text-zinc-400">atualiza sozinho</span>
      </CardHead>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {running.map((r) => (
          <div key={r.datasetId} className="flex items-center gap-2.5 px-3 py-2">
            <Loader2 size={13} className="shrink-0 animate-spin text-info dark:text-info-dark" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{r.name}</span>
            {r.kind === 'derived' && <Calculado />}
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
              {r.rows.toLocaleString('pt-BR')} linhas · {decorrido(r.startedAt)}
            </span>
          </div>
        ))}

        {pending.map((p, i) => (
          <div key={p.datasetId} className="flex items-center gap-2.5 px-3 py-2">
            <Clock size={13} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">{p.name}</span>
            {p.kind === 'derived' && <Calculado />}
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{i + 1}º na fila</span>
            <button
              onClick={() => void tirarDaFila([p.datasetId])}
              disabled={tirando}
              title="Tirar da fila"
              className="shrink-0 rounded p-0.5 text-zinc-300 hover:text-crit disabled:opacity-40 dark:text-zinc-600"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {recent.length > 0 && (
        <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
            Terminadas há pouco
          </p>
          <div className="space-y-0.5">
            {recent.slice(0, 6).map((r, i) => (
              <div key={`${r.datasetId}-${i}`} className="flex items-center gap-2 text-[11px]">
                {r.status === 'done'
                  ? <Check size={11} className="shrink-0 text-ok dark:text-ok-dark" />
                  : <X size={11} className="shrink-0 text-crit dark:text-crit-dark" />}
                <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">{r.name}</span>
                <span className="shrink-0 tabular-nums text-zinc-400">
                  {r.status === 'done' ? `${r.rows.toLocaleString('pt-BR')} linhas` : r.status} · {hora(r.finishedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}
