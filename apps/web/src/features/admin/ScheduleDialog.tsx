// Criar ou editar um agendamento (janela de horário + dias + intervalo em
// minutos). Era o diálogo da antiga tela Agendamentos; foi para arquivo próprio
// quando os agendamentos passaram a morar na tela de Regras de atualização.
import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { WEEKDAY_LABELS, type SyncSchedule } from '@datahub/shared'
import { api } from '@/lib/api'

export default function ScheduleDialog({ schedule, onClose, onSaved }: {
  /** Ausente = criar um novo. */
  schedule?: SyncSchedule
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(schedule?.name ?? '')
  const [interval, setInterval_] = useState(schedule?.intervalMinutes ?? 15)
  const [startTime, setStartTime] = useState(schedule?.startTime ?? '07:00')
  const [endTime, setEndTime] = useState(schedule?.endTime ?? '19:00')
  // Padrão de um novo: seg–sex, que é o caso mais comum.
  const [weekdays, setWeekdays] = useState(schedule?.weekdays ?? 62)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleDay(bit: number) {
    setWeekdays((w) => (w & (1 << bit) ? w & ~(1 << bit) : w | (1 << bit)))
  }
  const valid = name.trim() && interval >= 1 && interval <= 1440 && startTime < endTime && weekdays > 0

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const body = JSON.stringify({ name: name.trim(), intervalMinutes: interval, startTime, endTime, weekdays })
      if (schedule) await api(`/api/v1/schedules/${schedule.id}`, { method: 'PATCH', body })
      else await api('/api/v1/schedules', { method: 'POST', body })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
    } finally {
      setBusy(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const membros = schedule?.datasetCount ?? 0

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{schedule ? 'Editar agendamento' : 'Novo agendamento'}</h2>
          <button onClick={onClose} aria-label="Fechar" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        {membros > 0 && (
          <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            Afeta {membros} conjunto(s) que já seguem este agendamento.
          </p>
        )}
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inp} autoFocus
              placeholder="Ex.: Horário comercial, a cada 15 min" />
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
          {!schedule && (
            <p className="text-xs leading-relaxed text-zinc-500">
              Nasce sem conjunto. Para pôr um conjunto nele, escolha-o no campo Frequência do painel do
              conjunto, ou selecione vários em Conjuntos → Agendar atualização.
            </p>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={() => void save()} disabled={busy || !valid}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />}
            {schedule ? 'Salvar' : 'Criar agendamento'}
          </button>
        </div>
      </div>
    </div>
  )
}
