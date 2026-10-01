// ─────────────────────────────────────────────────────────────────────────
// Há quanto tempo um conjunto não é atualizado — a "defasagem".
//
// Estava copiado em Início e em Conjuntos, com os mesmos limiares escritos
// duas vezes. É o tipo de duplicação que não dá erro: basta alguém afrouxar
// 26h para 30h de um lado e o MESMO conjunto passa a ler "em dia" numa tela e
// "atrasado" na outra, sem nada apontar a contradição.
//
// O vocabulário também mora aqui. A coluna se chamava "Frescor" — jargão de
// engenharia de dados; passou a "Atualizado", com o valor em "há 3 h", que se
// lê sem tradução fora da área. O indicador do topo virou "Defasagem mediana":
// ali o que se mede é a estatística do catálogo, não a data de uma linha.
// ─────────────────────────────────────────────────────────────────────────

/** Horas desde a última sincronização. null = nunca sincronizou. */
export function hoursSince(iso: string | null): number | null {
  if (!iso) return null
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000
  return Number.isFinite(h) ? h : null
}

/** Duração nua: "40 min", "3 h", "2 d". Para KPI e para compor frase. */
export function lagLabel(h: number | null): string {
  if (h === null) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

/** A mesma duração como data de referência: "há 3 h". Para a coluna. */
export function lagSince(h: number | null): string {
  return h === null ? 'nunca' : `há ${lagLabel(h)}`
}

// Janela diária: até 26h é a cadência normal; acima disso a janela pulou.
export type LagTone = 'ok' | 'warn' | 'crit' | 'neutral'
export function lagTone(h: number | null): LagTone {
  if (h === null) return 'neutral'
  if (h <= 26) return 'ok'
  if (h <= 72) return 'warn'
  return 'crit'
}
