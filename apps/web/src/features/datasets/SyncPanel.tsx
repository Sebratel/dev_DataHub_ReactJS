// Painel de sincronização (admin): modo, chave incremental, disparo manual e
// histórico de execuções. O sync roda em fila no servidor; aqui só acompanhamos.
import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Play, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import type { DatasetDetail, SyncRun } from '@datahub/shared'
import { api } from '@/lib/api'

const MODE_LABEL: Record<string, string> = {
  live: 'Ao vivo (sem lake — apenas preview admin)',
  snapshot: 'Snapshot (recarrega tudo a cada sync)',
  incremental: 'Incremental (só novidades, por watermark)',
}

const CADENCE_LABEL: Record<string, string> = {
  daily: 'Diária (janela da madrugada)',
  hourly: 'De hora em hora',
  manual: 'Manual (só sob demanda)',
}

interface RawRun {
  id: string; mode: string; status: SyncRun['status']; rows: number; bytes: number
  error: string | null; started_at: string; finished_at: string | null
}

export default function SyncPanel({ dataset, onSynced }: { dataset: DatasetDetail; onSynced: () => void }) {
  const [mode, setMode] = useState(dataset.sync?.mode ?? 'live')
  const [incKey, setIncKey] = useState(dataset.sync?.incrementalKey ?? '')
  const [cadence, setCadence] = useState(dataset.sync?.cadence ?? 'daily')
  const [runs, setRuns] = useState<RawRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)

  const loadRuns = useCallback(async () => {
    try {
      const r = await api<{ runs: RawRun[] }>(`/api/v1/datasets/${dataset.id}/sync-runs`)
      setRuns(r.runs)
      return r.runs
    } catch { return [] }
  }, [dataset.id])

  useEffect(() => { void loadRuns() }, [loadRuns])

  // Enquanto houver run em andamento, acompanha a cada 2 s.
  useEffect(() => {
    if (!polling) return
    const t = setInterval(async () => {
      const rs = await loadRuns()
      if (!rs.some((r) => r.status === 'running')) {
        setPolling(false)
        onSynced()
      }
    }, 2000)
    return () => clearInterval(t)
  }, [polling, loadRuns, onSynced])

  async function saveConfig() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync-config`, {
        method: 'PATCH',
        body: JSON.stringify({ syncMode: mode, incrementalKey: incKey || null, syncCadence: cadence }),
      })
      onSynced()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar configuração.')
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync`, { method: 'POST' })
      setPolling(true)
      await loadRuns()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar sincronização.')
    } finally {
      setBusy(false)
    }
  }

  const numericOrDateFields = dataset.fields.filter((f) => !f.hidden && (f.type === 'number' || f.type === 'date'))

  return (
    <div className="mt-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Sincronização com o lake (admin)</h2>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Modo</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {mode === 'incremental' && (
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Chave incremental (número ou data crescente)</span>
            <select
              value={incKey}
              onChange={(e) => setIncKey(e.target.value)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— escolha —</option>
              {numericOrDateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
        )}
        {mode !== 'live' && (
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Cadência (com que frequência sincroniza sozinho)</span>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as typeof cadence)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              {Object.entries(CADENCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <button
          onClick={saveConfig}
          disabled={busy || (mode === 'incremental' && !incKey)}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Salvar configuração
        </button>
        {mode !== 'live' && (
          <button
            onClick={syncNow}
            disabled={busy || polling}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-60"
          >
            {polling ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {polling ? 'Sincronizando…' : 'Sincronizar agora'}
          </button>
        )}
        <button onClick={() => void loadRuns()} className="rounded-lg p-2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Atualizar histórico">
          <RefreshCw size={15} />
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      {runs.length > 0 && (
        <table className="mt-4 w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1.5 pr-4 font-medium">Início</th>
              <th className="py-1.5 pr-4 font-medium">Modo</th>
              <th className="py-1.5 pr-4 font-medium">Status</th>
              <th className="py-1.5 pr-4 text-right font-medium">Linhas novas</th>
              <th className="py-1.5 font-medium">Erro</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1.5 pr-4">{new Date(r.started_at).toLocaleString('pt-BR')}</td>
                <td className="py-1.5 pr-4">{r.mode}</td>
                <td className={clsx('py-1.5 pr-4 font-medium',
                  r.status === 'done' && 'text-emerald-600',
                  r.status === 'error' && 'text-red-500',
                  r.status === 'running' && 'text-amber-500')}>
                  {r.status === 'done' ? 'concluído' : r.status === 'error' ? 'erro' : 'executando…'}
                </td>
                <td className="py-1.5 pr-4 text-right">{Number(r.rows).toLocaleString('pt-BR')}</td>
                <td className="max-w-[260px] truncate py-1.5 text-red-500">{r.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
