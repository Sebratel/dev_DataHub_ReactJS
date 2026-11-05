// ─────────────────────────────────────────────────────────────────────────
// Verificações contínuas (D-QLD-2 A) — as REGRAS, sem banco.
//
//   • prazo   — o conjunto atualizou dentro do que a cadência dele promete?
//               O selo "Atualizado" da tela usa 26 h para qualquer cadência:
//               um conjunto de 5 em 5 min parado há 20 h aparece "em dia"
//               (MON-09). Aqui o limite sai da cadência;
//   • volume  — um snapshot encolheu de uma carga para a outra? Uma página
//               perdida no OFFSET substitui a cópia completa sem erro (QLD-08).
//
// Separado do resto para ser testado sem fonte nem banco (dev/qualitySmoke.ts).
// ─────────────────────────────────────────────────────────────────────────
import { isWithinSchedule } from '@datahub/shared'

/** Queda que conta como suspeita: 20% das linhas de uma carga para a outra. */
export const VOLUME_DROP = 0.2
/** Abaixo disto o percentual engana: 10 → 7 linhas é "30%" e não diz nada. */
export const VOLUME_MIN_PREV = 1000
/** Um calculado em cascata tem até isto para acompanhar um insumo que atualizou. */
export const CASCADE_LAG_MIN = 60

export interface StaleInput {
  kind: string
  syncMode: string
  cadence: string
  paused: boolean
  lastSyncAt: Date | null
  schedule: { intervalMinutes: number; startTime: string; endTime: string; weekdays: number } | null
  /** Calculado em cascata: a última carga de cada insumo. */
  inputs: { slug: string; lastSyncAt: Date | null }[]
}

export type StaleVerdict =
  // keep = não avaliar agora, mas manter o estado que já existe (ex.: fora da
  // janela do agendamento: o atraso de hoje continua sendo atraso amanhã cedo).
  | { evaluate: false; keep: boolean; reason: string }
  | { evaluate: true; late: boolean; detail: string }

export function idade(min: number): string {
  if (min < 60) return `${Math.max(0, Math.round(min))} min`
  if (min < 48 * 60) {
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    return m ? `${h} h ${m} min` : `${h} h`
  }
  return `${Math.round(min / 1440)} dias`
}

export function staleVerdict(d: StaleInput, now: Date): StaleVerdict {
  if (d.syncMode === 'live') return { evaluate: false, keep: false, reason: 'ao vivo: não há carga' }
  if (d.paused) return { evaluate: false, keep: false, reason: 'pausado: a pausa já tem alerta próprio' }
  if (d.cadence === 'manual') return { evaluate: false, keep: false, reason: 'manual: não promete atualização' }
  if (!d.lastSyncAt) return { evaluate: false, keep: false, reason: 'ainda sem carga concluída' }
  const ageMin = (now.getTime() - d.lastSyncAt.getTime()) / 60_000
  const ultima = `Última carga há ${idade(ageMin)}`

  if (d.cadence === 'hourly') {
    return { evaluate: true, late: ageMin > 120, detail: `${ultima}; de hora em hora, o limite é 2 h.` }
  }
  if (d.cadence === 'daily') {
    return { evaluate: true, late: ageMin > 26 * 60, detail: `${ultima}; diária, o limite é 26 h.` }
  }
  if (d.cadence === 'schedule') {
    const s = d.schedule
    if (!s) return { evaluate: false, keep: false, reason: 'agendamento não encontrado' }
    // Fora da janela o agendamento não promete nada. Dentro dela, a régua é
    // três intervalos (folga para a fila sequencial), nunca menos de 30 min.
    if (!isWithinSchedule(s, now)) return { evaluate: false, keep: true, reason: 'fora da janela do agendamento' }
    const limite = Math.max(3 * s.intervalMinutes, 30)
    const [hh, mm] = s.startTime.split(':').map(Number)
    const abriu = new Date(now)
    abriu.setHours(hh, mm, 0, 0)
    if ((now.getTime() - abriu.getTime()) / 60_000 < limite) {
      return { evaluate: false, keep: true, reason: 'a janela acabou de abrir' }
    }
    return {
      evaluate: true, late: ageMin > limite,
      detail: `${ultima}; a cada ${s.intervalMinutes} min dentro da janela, o limite é ${idade(limite)}.`,
    }
  }
  if (d.cadence === 'cascade') {
    // O calculado em cascata é refeito quando um insumo atualiza. Se o insumo
    // andou e ele não, a materialização está falhando ou travada — e o selo
    // "Atualizado" dele continua dizendo "agora" (QLD-10).
    const comCarga = d.inputs.filter((i) => i.lastSyncAt)
    if (!comCarga.length) return { evaluate: false, keep: false, reason: 'nenhum insumo carregado' }
    const recente = comCarga.reduce((a, b) => (a.lastSyncAt!.getTime() >= b.lastSyncAt!.getTime() ? a : b))
    const atraso = (recente.lastSyncAt!.getTime() - d.lastSyncAt.getTime()) / 60_000
    return {
      evaluate: true, late: atraso > CASCADE_LAG_MIN,
      detail: atraso > 0
        ? `O insumo ${recente.slug} atualizou ${idade(atraso)} depois da última materialização; em cascata, o limite é ${idade(CASCADE_LAG_MIN)}.`
        : 'Acompanha os insumos.',
    }
  }
  return { evaluate: false, keep: false, reason: `cadência ${d.cadence}` }
}

/** Snapshot: compara as linhas desta carga com as da anterior. null = não avalia. */
export function volumeVerdict(prev: number | null, cur: number): { fail: boolean; detail: string } | null {
  if (prev == null || prev < VOLUME_MIN_PREV) return null
  const fmt = (n: number) => n.toLocaleString('pt-BR')
  const queda = (prev - cur) / prev
  if (queda >= VOLUME_DROP) {
    return {
      fail: true,
      detail: `A carga trouxe ${fmt(cur)} linhas; a anterior, ${fmt(prev)} (−${Math.round(queda * 100)}%). ` +
        'Se a fonte não apagou esse volume, a leitura perdeu páginas e a cópia incompleta substituiu a completa.',
    }
  }
  return { fail: false, detail: `${fmt(cur)} linhas (anterior: ${fmt(prev)}).` }
}
