// Como um agendamento e uma cadência se escrevem na tela. Estava só na página
// de Agendamentos; com o painel do conjunto e a tabela de regras também
// precisando dizer "a cada 5 min, 08:00–18:00, seg–sex", a frase passou a
// morar aqui — três cópias divergiriam no primeiro ajuste feito só de um lado.
import { WEEKDAY_LABELS, type SyncSchedule } from '@datahub/shared'

export function weekdaysLabel(mask: number): string {
  const days = WEEKDAY_LABELS.filter((_, i) => mask & (1 << i))
  // seg-sex é o caso mais comum; nomear em vez de listar os 5 dias.
  if (mask === 62) return 'seg–sex'
  if (mask === 127) return 'todos os dias'
  return days.join(', ')
}

/** "a cada 5 min, 08:00–18:00, seg–sex" */
export function scheduleRhythm(s: Pick<SyncSchedule, 'intervalMinutes' | 'startTime' | 'endTime' | 'weekdays'>): string {
  return `a cada ${s.intervalMinutes} min, ${s.startTime}–${s.endTime}, ${weekdaysLabel(s.weekdays)}`
}

export const CADENCE_LABEL: Record<string, string> = {
  daily: 'Diária (janela da madrugada)',
  hourly: 'De hora em hora',
  manual: 'Manual (só sob demanda)',
  cascade: 'Em cascata (depois das fontes)',
}
