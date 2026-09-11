// Aplica um agendamento (janela de horário + dias + intervalo em minutos) a
// vários conjuntos de uma vez. Escolhe um já existente OU cria um novo sem
// sair do fluxo — o caso comum é "selecionei 5 conjuntos, quero todos na
// mesma janela comercial", não editar agendamento um por vez.
import { useEffect, useState } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { WEEKDAY_LABELS, type SyncSchedule } from '@datahub/shared'
import { api } from '@/lib/api'

const WEEKDAYS_UTIL = 62 // seg-sex (bits 1..5) — ponto de partida comum

export default function ScheduleAssignDialog({
  datasetIds, onClose, onApplied,
}: {
  datasetIds: string[]
  onClose: () => void
  onApplied: () => void
}) {
  const [schedules, setSchedules] = useState<SyncSchedule[] | null>(null)
  const [mode, setMode] = useState<'existing' | 'new'>('new')
  const [scheduleId, setScheduleId] = useState('')
  const [name, setName] = useState('')
  const [interval, setInterval_] = useState(10)
  const [startTime, setStartTime] = useState('07:00')
  const [endTime, setEndTime] = useState('19:00')
  const [weekdays, setWeekdays] = useState(WEEKDAYS_UTIL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ schedules: SyncSchedule[] }>('/api/v1/schedules')
      .then((r) => {
        setSchedules(r.schedules)
        if (r.schedules.length) { setMode('existing'); setScheduleId(r.schedules[0].id) }
      })
      .catch(() => setSchedules([]))
  }, [])

  function toggleDay(bit: number) {
    setWeekdays((w) => (w & (1 << bit) ? w & ~(1 << bit) : w | (1 << bit)))
  }

  const validNew = name.trim() && interval >= 1 && interval <= 1440 && startTime < endTime && weekdays > 0
  const valid = mode === 'existing' ? !!scheduleId : validNew

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      let id = scheduleId
      if (mode === 'new') {
        const r = await api<{ id: string }>('/api/v1/schedules', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), intervalMinutes: interval, startTime, endTime, weekdays }),
        })
        id = r.id
      }
      await api(`/api/v1/schedules/${id}/assign`, { method: 'POST', body: JSON.stringify({ datasetIds }) })
      onApplied()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao aplicar o agendamento.')
    } finally {
      setBusy(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Agendar atualização</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          Aplicando a <strong>{datasetIds.length}</strong> conjunto(s) selecionado(s).
        </p>

        {schedules === null ? (
          <p className="text-sm text-zinc-500">Carregando…</p>
        ) : (
          <div className="grid gap-3">
            {schedules.length > 0 && (
              <div className="flex gap-1">
                <button onClick={() => setMode('existing')}
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-xs ${mode === 'existing' ? 'border-accent bg-accent-soft dark:bg-zinc-800' : 'border-zinc-200 dark:border-zinc-700'}`}>
                  Usar existente
                </button>
                <button onClick={() => setMode('new')}
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-xs ${mode === 'new' ? 'border-accent bg-accent-soft dark:bg-zinc-800' : 'border-zinc-200 dark:border-zinc-700'}`}>
                  <Plus size={12} className="mr-1 inline" />Criar novo
                </button>
              </div>
            )}

            {mode === 'existing' ? (
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Agendamento</span>
                <select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} className={inp}>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.startTime}–{s.endTime} · a cada {s.intervalMinutes} min
                      {s.datasetCount ? ` · ${s.datasetCount} conjunto(s)` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Nome</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder="Ex.: Horário comercial" autoFocus />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Início</span>
                    <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inp} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Fim</span>
                    <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={inp} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">A cada (min)</span>
                    <input type="number" min={1} max={1440} value={interval}
                      onChange={(e) => setInterval_(Number(e.target.value) || 1)} className={inp} />
                  </label>
                </div>
                <div>
                  <span className="mb-1 block text-xs text-zinc-500">Dias da semana</span>
                  <div className="flex gap-1">
                    {WEEKDAY_LABELS.map((label, bit) => (
                      <button key={bit} onClick={() => toggleDay(bit)} type="button"
                        className={`flex-1 rounded-lg border px-1 py-1.5 text-xs capitalize ${weekdays & (1 << bit)
                          ? 'border-accent bg-accent-soft dark:bg-zinc-800' : 'border-zinc-200 text-zinc-400 dark:border-zinc-700'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            <button onClick={() => void apply()} disabled={busy || !valid}
              className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />}
              Aplicar a {datasetIds.length} conjunto(s)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
