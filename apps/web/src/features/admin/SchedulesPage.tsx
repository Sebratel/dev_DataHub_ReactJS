// Administração de agendamentos (janela de horário + dias + intervalo em
// minutos), aplicados em lote a conjuntos de dados. Ver ScheduleAssignDialog
// (na tela de Conjuntos) para o fluxo de "selecionei N, aplica a todos".
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Pencil, Trash2, X, CalendarClock } from 'lucide-react'
import { WEEKDAY_LABELS, type SyncSchedule, type DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, ErrorBanner, EmptyState } from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'

function weekdaysLabel(mask: number): string {
  const days = WEEKDAY_LABELS.filter((_, i) => mask & (1 << i))
  // seg-sex é o caso mais comum; nomear em vez de listar os 5 dias.
  if (mask === 62) return 'seg–sex'
  if (mask === 127) return 'todos os dias'
  return days.join(', ')
}

export default function SchedulesPage() {
  const confirm = useConfirm()
  const [schedules, setSchedules] = useState<SyncSchedule[] | null>(null)
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<SyncSchedule | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  function load() {
    api<{ schedules: SyncSchedule[] }>('/api/v1/schedules')
      .then((r) => setSchedules(r.schedules))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }
  useEffect(() => {
    load()
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets)).catch(() => {})
  }, [])

  const byScheduleId = useMemo(() => {
    const m = new Map<string, DatasetSummary[]>()
    for (const d of datasets) {
      const sid = d.sync?.scheduleId
      if (sid) m.set(sid, [...(m.get(sid) ?? []), d])
    }
    return m
  }, [datasets])

  async function remove(s: SyncSchedule) {
    const ok = await confirm({
      title: 'Excluir agendamento',
      message: s.datasetCount
        ? `"${s.name}" está em uso por ${s.datasetCount} conjunto(s). Eles voltam para a cadência diária. Não dá para desfazer.`
        : `"${s.name}" será excluído. Não dá para desfazer.`,
      danger: true, confirmLabel: 'Excluir',
    })
    if (!ok) return
    setBusyId(s.id)
    try {
      await api(`/api/v1/schedules/${s.id}?force=true`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
    } finally {
      setBusyId(null)
    }
  }

  async function unassign(datasetId: string) {
    setBusyId(datasetId)
    try {
      await api('/api/v1/schedules/unassign', { method: 'POST', body: JSON.stringify({ datasetIds: [datasetId] }) })
      const r = await api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      setDatasets(r.datasets)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao remover.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Page>
      <PageHeader
        icon={CalendarClock}
        title="Agendamentos"
        subtitle="Janela de horário, dias da semana e intervalo em minutos — aplicados em lote a conjuntos de dados."
      />
      {error && <ErrorBanner message={error} />}

      <Card>
        <CardHead icon={CalendarClock} title="Agendamentos" sub={schedules ? String(schedules.length) : undefined} />
        {schedules === null ? (
          <p className="px-3 py-8 text-center text-[12px] text-zinc-500">Carregando…</p>
        ) : schedules.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            message="Nenhum agendamento ainda. Crie um selecionando conjuntos em Conjuntos de dados → Agendar atualização."
          />
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {schedules.map((s) => {
              const members = byScheduleId.get(s.id) ?? []
              const isOpen = expanded === s.id
              return (
                <div key={s.id}>
                  <div className="flex items-center gap-3 p-3">
                    <button onClick={() => setExpanded(isOpen ? null : s.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      {isOpen ? <ChevronDown size={14} className="shrink-0 text-zinc-400" /> : <ChevronRight size={14} className="shrink-0 text-zinc-400" />}
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{s.name}</p>
                        <p className="truncate text-[11px] text-zinc-500">
                          {s.startTime}–{s.endTime} · {weekdaysLabel(s.weekdays)} · a cada {s.intervalMinutes} min
                          · {s.datasetCount ?? 0} conjunto(s)
                        </p>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {busyId === s.id && <Loader2 size={13} className="mr-1 animate-spin text-zinc-400" />}
                      <button onClick={() => setEditing(s)} title="Editar"
                        className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                        <Pencil size={14} strokeWidth={1.6} />
                      </button>
                      <button onClick={() => void remove(s)} disabled={busyId === s.id} title="Excluir"
                        className="rounded-md p-1.5 text-zinc-400 hover:bg-crit-soft hover:text-crit disabled:opacity-50 dark:hover:bg-crit/10 dark:hover:text-crit-dark">
                        <Trash2 size={14} strokeWidth={1.6} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="bg-zinc-50 px-3 pb-3 dark:bg-zinc-950/40">
                      {members.length === 0 ? (
                        <p className="py-2 text-[11.5px] text-zinc-400">Nenhum conjunto usando este agendamento.</p>
                      ) : (
                        <div className="grid gap-1 pt-1">
                          {members.map((d) => (
                            <div key={d.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] dark:border-zinc-800 dark:bg-zinc-900">
                              <span className="truncate">{d.name}</span>
                              <button onClick={() => void unassign(d.id)} disabled={busyId === d.id} title="Tirar deste agendamento"
                                className="shrink-0 text-zinc-300 hover:text-crit disabled:opacity-50 dark:text-zinc-600">
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {editing && (
        <EditScheduleDialog schedule={editing} onClose={() => setEditing(null)} onSaved={load} />
      )}
    </Page>
  )
}

function EditScheduleDialog({ schedule, onClose, onSaved }: { schedule: SyncSchedule; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(schedule.name)
  const [interval, setInterval_] = useState(schedule.intervalMinutes)
  const [startTime, setStartTime] = useState(schedule.startTime)
  const [endTime, setEndTime] = useState(schedule.endTime)
  const [weekdays, setWeekdays] = useState(schedule.weekdays)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleDay(bit: number) {
    setWeekdays((w) => (w & (1 << bit) ? w & ~(1 << bit) : w | (1 << bit)))
  }
  const valid = name.trim() && interval >= 1 && interval <= 1440 && startTime < endTime && weekdays > 0

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/schedules/${schedule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), intervalMinutes: interval, startTime, endTime, weekdays }),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
    } finally {
      setBusy(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Editar agendamento</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        {(schedule.datasetCount ?? 0) > 0 && (
          <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            Afeta {schedule.datasetCount} conjunto(s) que já usam este agendamento.
          </p>
        )}
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inp} autoFocus />
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
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={() => void save()} disabled={busy || !valid}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
