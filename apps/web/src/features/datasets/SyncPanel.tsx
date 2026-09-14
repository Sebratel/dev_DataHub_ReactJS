// Painel de sincronização (admin): modo, chave incremental, disparo manual e
// histórico de execuções. O sync roda em fila no servidor; aqui só acompanhamos.
import { useState } from 'react'
import { Play, Loader2, Square } from 'lucide-react'
import type { DatasetDetail } from '@datahub/shared'
import { api } from '@/lib/api'
import RunsHistory, { useSyncRuns } from './RunsHistory'

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

export default function SyncPanel({ dataset, onSynced }: { dataset: DatasetDetail; onSynced: () => void }) {
  const [mode, setMode] = useState(dataset.sync?.mode ?? 'live')
  const [incKey, setIncKey] = useState(dataset.sync?.incrementalKey ?? '')
  const [cadence, setCadence] = useState(dataset.sync?.cadence ?? 'daily')
  const [since, setSince] = useState(dataset.sync?.since ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { runs, isRunning: runningNow } = useSyncRuns(dataset.id, onSynced)

  async function saveConfig() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync-config`, {
        method: 'PATCH',
        // Cadencia 'schedule' e' controlada pela tela de Agendamentos -- nao
        // reenvia o valor aqui, senao um clique em "Salvar configuracao" por
        // outro motivo (mudar o modo, por exemplo) e recusado pelo backend
        // (que so aceita daily/hourly/manual nesta rota).
        body: JSON.stringify({
          syncMode: mode, incrementalKey: incKey || null,
          syncCadence: dataset.sync?.cadence === 'schedule' ? undefined : cadence,
          syncSince: since || null,
        }),
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
      // useSyncRuns pega o novo run sozinho no proximo poll (3s) -- nao
      // precisa de um loadRuns() manual aqui.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar sincronização.')
    } finally {
      setBusy(false)
    }
  }

  async function cancelNow() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/sync-cancel`, { method: 'POST' })
      // o run passa a 'cancelled' no proximo checkpoint entre lotes; o hook
      // useSyncRuns pega isso sozinho no proximo poll.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao parar a sincronização.')
    } finally {
      setBusy(false)
    }
  }

  const numericOrDateFields = dataset.fields.filter((f) => !f.hidden && (f.type === 'number' || f.type === 'date'))

  return (
    <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
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
        {mode === 'incremental' && incKey && (
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">
              Publicar a partir de <span className="text-zinc-400">(opcional — corta a 1ª carga)</span>
            </span>
            <input
              type={dataset.fields.find((f) => f.key === incKey)?.type === 'date' ? 'date' : 'number'}
              value={since}
              onChange={(e) => setSince(e.target.value)}
              placeholder="tudo desde o início"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        )}
        {mode !== 'live' && dataset.sync?.cadence === 'schedule' && (
          // Cadencia 'schedule' NAO tem opcao no dropdown abaixo -- se ele
          // renderizasse mesmo assim, o <select> ficaria com um valor que
          // nao bate com nenhuma <option>, e salvar sem mexer em nada
          // sobrescreveria silenciosamente o agendamento em lote por engano.
          <p className="max-w-[220px] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            Controlado por um agendamento em lote. Gerencie em Administração › Agendamentos.
          </p>
        )}
        {mode !== 'live' && dataset.sync?.cadence !== 'schedule' && (
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
            disabled={busy || runningNow}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-60"
          >
            {runningNow ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {runningNow ? 'Sincronizando…' : 'Sincronizar agora'}
          </button>
        )}
        {runningNow && (
          <button
            onClick={cancelNow}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Square size={14} /> Parar
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      <RunsHistory runs={runs} />
    </div>
  )
}
