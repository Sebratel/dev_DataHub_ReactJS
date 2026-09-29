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
import { Loader2, Check, X, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardHead } from '@/components/ui/Card'

interface Fila {
  running: { datasetId: string; name: string; mode: string; rows: number; startedAt: string }[]
  pending: { datasetId: string; name: string }[]
  recent: {
    datasetId: string; name: string; mode: string; status: string
    rows: number; error: string | null; finishedAt: string | null
  }[]
}

const hora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'

function decorrido(desde: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(desde).getTime()) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export default function SyncQueueCard() {
  const [fila, setFila] = useState<Fila | null>(null)

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
        <span className="text-[10.5px] text-zinc-400">atualiza sozinho</span>
      </CardHead>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {running.map((r) => (
          <div key={r.datasetId} className="flex items-center gap-2.5 px-3 py-2">
            <Loader2 size={13} className="shrink-0 animate-spin text-info dark:text-info-dark" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{r.name}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
              {r.rows.toLocaleString('pt-BR')} linhas · {decorrido(r.startedAt)}
            </span>
          </div>
        ))}

        {pending.map((p, i) => (
          <div key={p.datasetId} className="flex items-center gap-2.5 px-3 py-2">
            <Clock size={13} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">{p.name}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{i + 1}º na fila</span>
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
