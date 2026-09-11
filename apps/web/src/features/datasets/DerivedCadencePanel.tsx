// Cadência de um conjunto DERIVADO (admin/dono). Simétrico ao SyncPanel das
// fontes, mas sem modo/chave incremental/"desde" — um derivado não lê fonte
// nenhuma, só recalcula o SQL sobre o lake.
//
// 'cascade' é a opção nova: em vez de esperar o relógio (hourly/daily) bater,
// o derivado recalcula sozinho assim que QUALQUER fonte ou derivado que ele
// referencia no SQL termina uma sincronização com sucesso (ver cascadeToDependents
// em ingest.ts). Isto é o que faltava para "quando a fonte atualiza, o
// calculado também atualiza" — antes, um derivado 'daily' ficava até 24h atrás
// de uma fonte 'hourly', mesmo a fonte já tendo dado novo havia muito tempo.
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { DatasetDetail } from '@datahub/shared'
import { api } from '@/lib/api'

const CADENCE_LABEL: Record<string, string> = {
  cascade: 'Automática — recalcula quando as fontes atualizam',
  hourly: 'De hora em hora',
  daily: 'Diária (janela da madrugada)',
  manual: 'Manual (só sob demanda)',
}

export default function DerivedCadencePanel({ dataset, onSaved }: { dataset: DatasetDetail; onSaved: () => void }) {
  const [cadence, setCadence] = useState(dataset.sync?.cadence ?? 'daily')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await api(`/api/v1/datasets/derived/${dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ syncCadence: cadence }),
      })
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar cadência.')
    } finally {
      setBusy(false)
    }
  }

  // Cadência 'schedule' não aparece no dropdown (a gravação dela precisa vir
  // emparelhada com schedule_id, algo que só a tela de Agendamentos faz) — e
  // por isso este painel não pode nem tentar renderizar o <select> nesse
  // estado: sem opção correspondente selecionada, um clique acidental em
  // "Salvar cadência" reverteria o agendamento em lote para outra coisa.
  if (dataset.sync?.cadence === 'schedule') {
    return (
      <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Atualização automática (admin)</h2>
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          Controlado por um agendamento em lote. Gerencie em Administração › Agendamentos.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Atualização automática (admin)</h2>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Cadência</span>
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value as typeof cadence)}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {Object.entries(CADENCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <button
          onClick={save}
          disabled={busy || cadence === (dataset.sync?.cadence ?? 'daily')}
          className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {saved ? 'Salvo' : 'Salvar cadência'}
        </button>
      </div>
      {cadence === 'cascade' && (
        <p className="mt-2 text-xs text-zinc-500">
          Recalcula assim que qualquer conjunto referenciado no SQL deste derivado terminar de sincronizar —
          não precisa esperar a janela diária nem a hora cheia.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </div>
  )
}
