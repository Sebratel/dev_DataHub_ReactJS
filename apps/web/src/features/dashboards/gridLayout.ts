// Ponte entre o nosso modelo de widget e o react-grid-layout (grid de 12
// colunas, posição livre x/y/w/h). Widgets sem layout salvo (recém-migrados ou
// recém-criados) ganham um layout de fluxo — esquerda→direita, quebrando a
// cada 12 colunas — posicionado ABAIXO dos que já têm posição salva.
import type { Widget, WidgetType } from '@datahub/shared'

export const GRID_COLS = 12
export const GRID_ROW_H = 56 // px por linha do grid (mesma cadência do dashboards_IA)

export interface RglItem { i: string; x: number; y: number; w: number; h: number; minW: number; minH: number }

// Largura padrão (em colunas) a partir do "tamanho" legado.
const SIZE_W: Record<Widget['size'], number> = { sm: 3, md: 6, lg: 12 }
// Altura padrão (em linhas) por tipo — KPI é baixo; gráficos precisam de área.
function defaultH(type: WidgetType): number {
  return type === 'kpi' ? 2 : 5
}
function minH(type: WidgetType): number {
  return type === 'kpi' ? 2 : 3
}

// Resolve o array de layout do react-grid-layout para os widgets de UMA aba.
export function resolveLayout(widgets: Widget[]): RglItem[] {
  const placed: RglItem[] = widgets
    .filter((w) => w.layout)
    .map((w) => ({ i: w.id, x: w.layout!.x, y: w.layout!.y, w: w.layout!.w, h: w.layout!.h, minW: 2, minH: minH(w.type) }))

  let y = placed.reduce((m, l) => Math.max(m, l.y + l.h), 0)
  let x = 0
  let rowH = 0
  const auto: RglItem[] = []
  for (const w of widgets.filter((w) => !w.layout)) {
    const wd = SIZE_W[w.size] ?? 6
    const h = defaultH(w.type)
    if (x + wd > GRID_COLS) { x = 0; y += rowH; rowH = 0 }
    auto.push({ i: w.id, x, y, w: wd, h, minW: 2, minH: minH(w.type) })
    x += wd
    rowH = Math.max(rowH, h)
  }
  return [...placed, ...auto]
}
