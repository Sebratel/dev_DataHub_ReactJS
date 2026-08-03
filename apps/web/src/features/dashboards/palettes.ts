// Paletas prontas para widgets e para a paleta padrão do dashboard.
// "Padrão (marca)" = usar a paleta de marca validada (viz.ts).
export const PALETTES: Record<string, string[] | undefined> = {
  'Padrão (marca)': undefined,
  'Quente': ['#e34948', '#eb6834', '#eda100', '#e87ba4', '#d55181'],
  'Frio': ['#2a78d6', '#1baf7a', '#4a3aa7', '#008300', '#3987e5'],
  'Mono âmbar': ['#f59e0b', '#d97706', '#fbbf24', '#b45309', '#fcd34d'],
}

// Nome do preset cuja paleta bate com a salva (para pré-selecionar no editor).
export function paletteNameOf(pal?: string[]): string {
  if (!pal) return 'Padrão (marca)'
  const hit = Object.entries(PALETTES).find(([, v]) => v && JSON.stringify(v) === JSON.stringify(pal))
  return hit ? hit[0] : 'Padrão (marca)'
}
