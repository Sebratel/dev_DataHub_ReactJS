// Tabela de dados do lake — visível a qualquer usuário quando o dataset já
// foi sincronizado. Versão simples; o Explorador completo chega no Sprint 4.
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { DatasetDetail, QueryResult } from '@datahub/shared'
import { api } from '@/lib/api'

export default function DataTable({ dataset }: { dataset: DatasetDetail }) {
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setBusy(true)
    setResult(null)
    setError(null)
    api<QueryResult>(`/api/v1/datasets/${dataset.slug}/query`, {
      method: 'POST',
      body: JSON.stringify({ limit: 100 }),
    })
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao consultar os dados.'))
      .finally(() => setBusy(false))
  }, [dataset.slug, dataset.lastSyncAt])

  const labelByKey = new Map(dataset.fields.map((f) => [f.key, f.label]))

  if (busy) {
    return <p className="mt-5 flex items-center gap-2 text-sm text-zinc-500"><Loader2 size={14} className="animate-spin" /> Consultando o lake…</p>
  }
  if (error) {
    return <p className="mt-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">{error}</p>
  }
  if (!result) return null

  return (
    <>
      <h2 className="mt-5 text-sm font-medium uppercase tracking-wider text-zinc-400">
        Dados
        <span className="ml-2 normal-case tracking-normal text-zinc-400">
          {result.total !== undefined && `${result.total.toLocaleString('pt-BR')} registros · `}
          exibindo {result.rows.length} · {result.tookMs} ms
        </span>
      </h2>
      <div className="mt-3 max-h-[480px] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
            <tr>
              {result.columns.map((c) => (
                <th key={c.name} className="whitespace-nowrap px-3 py-2 font-medium">{labelByKey.get(c.name) ?? c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-zinc-950">
            {result.rows.map((row, i) => (
              <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                {result.columns.map((c) => (
                  <td key={c.name} className="max-w-[240px] truncate whitespace-nowrap px-3 py-1.5">
                    {row[c.name] === null || row[c.name] === undefined ? '—' : String(row[c.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
