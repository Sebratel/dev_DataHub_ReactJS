// Histórico de execuções de sincronização/materialização — extraído do
// SyncPanel para ser usado também pelos conjuntos CALCULADOS, que até aqui
// não tinham NENHUMA visibilidade sobre por que uma materialização falhou.
// O erro ficava só no log do servidor: "salvei e nunca mais vi os dados" era
// exatamente esse sintoma, sem nada na tela para explicar.
//
// Separado em hook (busca + poll) e componente (tabela), para quem dispara a
// sincronização (SyncPanel tem "Sincronizar agora"; DerivedCadencePanel tem
// "Materializar agora") também possa saber se HÁ um run em andamento, sem
// duplicar o polling.
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SyncRun } from '@datahub/shared'
import { api } from '@/lib/api'

export interface RawRun {
  id: string; mode: string; status: SyncRun['status']; rows: number; bytes: number
  error: string | null; started_at: string; finished_at: string | null
  // Custo da compactacao desta execucao. A compactacao reescreve o conjunto
  // INTEIRO, e so acontece quando ha identidade repetida para colapsar (ou
  // quando os arquivos passam do teto) -- ver ingest.ts. Sem estas tres
  // colunas na tela, "por que este conjunto pesa no servidor?" so tinha
  // resposta no log.
  compacted?: boolean; compact_ms?: number | null; parts?: number | null
}

const STATUS_LABEL: Record<string, string> = {
  done: 'concluído', error: 'erro', cancelled: 'cancelado', running: 'executando…',
}

// Poll simples e incondicional (a cada 3s, enquanto a tela estiver aberta) em
// vez de liga/desliga coordenado por quem disparou o run — é uma página de
// detalhe de UM conjunto, vista por um admin; o custo de mais um GET pequeno
// a cada 3s não paga a complexidade de sincronizar dois componentes que não
// se conhecem (o botão do menu de DatasetDetailPage e este painel).
export function useSyncRuns(datasetId: string, onSynced?: () => void) {
  const [runs, setRuns] = useState<RawRun[]>([])
  // Lembra o topo anterior para chamar onSynced() só na TRANSIÇÃO
  // running -> terminal, não a cada poll ocioso.
  const prevTop = useRef<{ id: string; status: string } | null>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const r = await api<{ runs: RawRun[] }>(`/api/v1/datasets/${datasetId}/sync-runs`)
        if (!alive) return
        setRuns(r.runs)
        const top = r.runs[0]
        if (top && prevTop.current?.id === top.id && prevTop.current.status === 'running' && top.status !== 'running') {
          onSynced?.()
        }
        prevTop.current = top ? { id: top.id, status: top.status } : null
      } catch { /* mantém o último histórico bom na tela */ }
    }
    void load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [datasetId, onSynced])

  return { runs, isRunning: runs.some((r) => r.status === 'running') }
}

export default function RunsHistory({ runs }: { runs: RawRun[] }) {
  if (runs.length === 0) return null

  return (
    <table className="mt-4 w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-1.5 pr-4 font-medium">Início</th>
          <th className="py-1.5 pr-4 font-medium">Modo</th>
          <th className="py-1.5 pr-4 font-medium">Status</th>
          <th className="py-1.5 pr-4 text-right font-medium">Linhas</th>
          <th className="py-1.5 pr-4 font-medium">Compactação</th>
          <th className="py-1.5 font-medium">Erro</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
            <td className="whitespace-nowrap py-1.5 pr-4">{new Date(r.started_at).toLocaleString('pt-BR')}</td>
            <td className="whitespace-nowrap py-1.5 pr-4">{r.mode}</td>
            <td className={clsx('whitespace-nowrap py-1.5 pr-4 font-medium',
              r.status === 'done' && 'text-emerald-600',
              r.status === 'error' && 'text-red-500',
              r.status === 'running' && 'text-amber-500',
              r.status === 'cancelled' && 'text-zinc-500')}>
              {STATUS_LABEL[r.status] ?? r.status}
            </td>
            <td className="whitespace-nowrap py-1.5 pr-4 text-right">{Number(r.rows).toLocaleString('pt-BR')}</td>
            {/* "dispensada" e o caso BOM e o mais comum: o lote so trouxe
                linhas novas, entao nao havia nada a colapsar e o conjunto
                inteiro nao precisou ser reescrito. */}
            <td className="whitespace-nowrap py-1.5 pr-4 text-zinc-500">
              {r.status !== 'done' ? '' : r.compacted
                ? `${Number(r.compact_ms ?? 0).toLocaleString('pt-BR')} ms`
                : 'dispensada'}
              {r.parts != null && <span className="ml-1.5 text-zinc-400">· {r.parts} arq.</span>}
            </td>
            {/* Erro completo, sem truncar: um erro do DuckDB costuma vir com o
                trecho de SQL e a posição — cortado em 260px sobrava só o
                começo, sem a parte que diz o que de fato deu errado. */}
            <td className="max-w-[480px] whitespace-pre-wrap break-words py-1.5 font-mono text-[11px] text-red-500">
              {r.error ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
