// Versões do SQL de um calculado (achado DSP-03 do comitê). Toda gravação de
// SQL vira versão; aqui dá para ver cada uma e voltar a uma anterior — a volta
// não apaga nada, vira uma versão nova.
//
// Oficial: o SQL está congelado para o dono; só admin altera ou restaura.
import { useCallback, useEffect, useState } from 'react'
import { History, ChevronDown, Loader2, RotateCcw, Lock } from 'lucide-react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'

interface SqlVersion {
  version: number
  sql: string
  createdBy: string
  createdAt: string
  note: string | null
  current: boolean
}

export default function SqlVersions({ datasetId, official, canRestore, onRestored }: {
  datasetId: string
  official: boolean
  /** Admin, ou o dono quando o conjunto não é oficial — a mesma regra do backend. */
  canRestore: boolean
  onRestored: () => void
}) {
  const confirm = useConfirm()
  const [versions, setVersions] = useState<SqlVersion[] | null>(null)
  const [aberto, setAberto] = useState(false)
  const [vendo, setVendo] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<{ versions: SqlVersion[] }>(`/api/v1/datasets/derived/${datasetId}/versions`)
      .then((r) => setVersions(r.versions))
      .catch(() => setVersions([]))
  }, [datasetId])
  useEffect(load, [load])

  async function restaurar(v: SqlVersion) {
    const ok = await confirm({
      title: `Voltar à versão ${v.version}?`,
      message: 'O SQL atual continua guardado como versão. O conjunto é recalculado com o SQL desta versão.',
      confirmLabel: 'Restaurar esta versão',
    })
    if (!ok) return
    setBusy(v.version)
    setError(null)
    try {
      await api(`/api/v1/datasets/derived/${datasetId}/versions/${v.version}/restore`, { method: 'POST' })
      load()
      onRestored()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao restaurar.')
    } finally {
      setBusy(null)
    }
  }

  const n = versions?.length ?? 0

  return (
    <div className="mt-2">
      {official && (
        <p className="mb-2 flex items-start gap-1.5 text-[12px] text-zinc-500">
          <Lock size={13} className="mt-0.5 shrink-0 text-secondary" />
          Conjunto oficial: o SQL está congelado. Só um administrador altera, e cada versão fica guardada.
        </p>
      )}
      <button
        onClick={() => setAberto((x) => !x)}
        disabled={!n}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-zinc-500 hover:text-zinc-900 disabled:cursor-default disabled:opacity-60 dark:hover:text-zinc-100"
      >
        {versions === null ? <Loader2 size={13} className="animate-spin" /> : <History size={13} />}
        Versões do SQL{versions ? ` (${n})` : ''}
        {n > 0 && <ChevronDown size={13} className={clsx('transition-transform', aberto && 'rotate-180')} />}
      </button>

      {error && <p className="mt-2 rounded-lg bg-red-50 p-2.5 text-[12px] text-red-600 dark:bg-red-950/40">{error}</p>}

      {aberto && versions && (
        <ul className="mt-2 space-y-1.5">
          {versions.map((v) => (
            <li key={v.version} className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
                <span className="font-semibold tabular-nums">v{v.version}</span>
                {v.current && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-secondary dark:bg-zinc-800">
                    em vigor
                  </span>
                )}
                <span className="text-zinc-500">{v.createdBy}</span>
                <span className="text-zinc-400">{new Date(v.createdAt).toLocaleString('pt-BR')}</span>
                {v.note && <span className="min-w-0 truncate text-zinc-500" title={v.note}>· {v.note}</span>}
                <span className="ml-auto inline-flex items-center gap-1.5">
                  <button
                    onClick={() => setVendo(vendo === v.version ? null : v.version)}
                    className="rounded-lg border border-zinc-200 px-2 py-0.5 text-[11px] hover:border-zinc-300 dark:border-zinc-700"
                  >
                    {vendo === v.version ? 'Esconder' : 'Ver SQL'}
                  </button>
                  {canRestore && !v.current && (
                    <button
                      onClick={() => void restaurar(v)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-0.5 text-[11px] hover:border-zinc-300 disabled:opacity-50 dark:border-zinc-700"
                    >
                      {busy === v.version ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Restaurar
                    </button>
                  )}
                </span>
              </div>
              {vendo === v.version && (
                <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed dark:bg-zinc-900">
                  {v.sql}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
