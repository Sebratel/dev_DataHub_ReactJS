// Paleta categórica VALIDADA (dataviz: lightness band, chroma, CVD ≥ 12 no
// claro, contraste ≥ 3:1 no escuro). Slots em ordem FIXA — nunca ciclar.
// WARNs de contraste do modo claro são mitigados por tooltip + legenda + tabela.
export const PALETTE_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
export const PALETTE_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']

export function palette(theme: 'light' | 'dark'): string[] {
  return theme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
}

// Tokens recessivos de grade/eixo e texto (o texto NUNCA usa a cor da série).
export function vizTokens(theme: 'light' | 'dark') {
  return theme === 'dark'
    ? { grid: '#2e2e2d', axis: '#8a897f', text: '#c3c2b7', surface: '#18181b' }
    : { grid: '#e8e8e6', axis: '#71717a', text: '#52525b', surface: '#ffffff' }
}

export function formatValue(
  v: unknown,
  format: 'number' | 'currency' | 'percent' = 'number',
  decimals?: number,
): string {
  const n = Number(v)
  if (v === null || v === undefined || Number.isNaN(n)) return '—'
  if (format === 'currency') return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: decimals ?? 0 })
  if (format === 'percent') return `${(n * 100).toLocaleString('pt-BR', { maximumFractionDigits: decimals ?? 1 })}%`
  return n.toLocaleString('pt-BR', { maximumFractionDigits: decimals ?? 2 })
}
