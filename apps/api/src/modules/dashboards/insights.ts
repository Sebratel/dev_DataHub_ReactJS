// ─────────────────────────────────────────────────────────────────────────
// Insight de IA por widget — o gráfico mostra O QUE aconteceu; o insight diz
// O QUE ISSO SIGNIFICA. Era a peça que faltava do construtor de painéis.
//
// Três decisões que moldam este módulo:
//
// 1. O SERVIDOR é dono dos dados e da permissão. O cliente manda o QueryDef que
//    ele já montou (mesma coisa que /query aceita hoje), mas quem executa e
//    quem confere o acesso é aqui — a IA nunca opina sobre número que o usuário
//    não poderia ver.
//
// 2. CACHE PELO HASH DOS DADOS. Insight sobre número velho é pior que nenhum
//    insight, porque parece válido. Mesma consulta + mesmo resultado = mesmo
//    texto, sem nova chamada ao provedor. Um painel em modo TV recarregando de
//    minuto em minuto seria uma fatura absurda sem isso.
//
// 3. JSON PEDIDO NO PROMPT, não structured output. São três provedores com
//    suportes diferentes a saída estruturada; pedir JSON e fazer o parse
//    tolerante é o que funciona igual nos três.
import { createHash } from 'node:crypto'
import { db } from '../../db/pool.js'
import type { QueryDef, FieldType } from '@datahub/shared'
import { canQuery, type AccessUser } from '../../core/access.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'
import { parquetGlob, datasetDir } from '../../core/lake.js'
import { activeProvider } from '../ai/providerStore.js'

export interface WidgetInsight {
  headline: string
  bullets: string[]
  tone: 'positive' | 'attention' | 'neutral'
  provider: string
  model: string
  tookMs: number
  /** true = veio do cache (mesmos dados de antes). */
  cached: boolean
}

// Cache de processo: widgetId → insight + hash dos dados que o geraram.
// Morre no restart, e tudo bem: reiniciou, os dados provavelmente mudaram.
const cache = new Map<string, { hash: string; insight: WidgetInsight }>()
const MAX_CACHE = 500

function remember(widgetId: string, hash: string, insight: WidgetInsight): void {
  // Poda burra mas suficiente: quando estoura, descarta o mais antigo inserido.
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(widgetId, { hash, insight })
}

const PROMPT = `Você analisa UM gráfico de painel do Data Hub da Sebratel (provedor de internet). Responda em português do Brasil.

Você recebe a definição do gráfico e os dados JÁ AGREGADOS que ele mostra. Sua tarefa é dizer o que esses números significam para quem opera o negócio.

Responda SOMENTE com um objeto JSON, sem cercas de código e sem texto fora dele:
{"headline": "…", "bullets": ["…", "…"], "tone": "positive|attention|neutral"}

- headline: UMA frase que responde "e daí?". O achado principal, com o número que o sustenta. Nunca repita o título do gráfico.
- bullets: 2 a 4 observações curtas e distintas. Concentração, tendência, exceção, comparação entre categorias. Cada uma citando o número que a sustenta.
- tone: "attention" se houver algo que exige ação, "positive" se o quadro é bom, "neutral" caso contrário.

Regras que importam:
- Só afirme o que os dados mostram. NÃO invente causa ("por conta da sazonalidade"), não sugira ação que os dados não sustentam, não compare com período que você não recebeu.
- Se os dados forem poucos ou insuficientes para concluir algo, diga isso na headline e devolve bullets vazios. É melhor que inventar.
- Sem saudação, sem "aqui está a análise", sem recomendação genérica de consultoria.`

// Extrai o JSON mesmo quando o modelo embrulha em cerca de código ou escreve
// uma frase antes — acontece com todos os três provedores, em graus diferentes.
function parseInsight(text: string): { headline: string; bullets: string[]; tone: string } | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const headline = String(o.headline ?? '').trim()
    if (!headline) return null
    return {
      headline,
      bullets: Array.isArray(o.bullets) ? o.bullets.map(String).filter(Boolean).slice(0, 4) : [],
      tone: String(o.tone ?? 'neutral'),
    }
  } catch {
    return null
  }
}

const TONES = new Set(['positive', 'attention', 'neutral'])

interface WidgetRow {
  id: string
  title: string
  type: string
  dataset_id: string
  dataset_slug: string
  dataset_name: string
  spec: unknown
  dimension: string | null
  metric: unknown
}

export async function generateInsight(
  user: AccessUser, dashboardId: string, widgetId: string, def: QueryDef, force: boolean,
): Promise<WidgetInsight> {
  const w = (await db.query(
    `select w.id, w.title, w.type, w.dimension, w.metric, w.spec,
            d.id as dataset_id, d.slug as dataset_slug, d.name as dataset_name
       from widgets w
       join datasets d on d.id = w.dataset_id
       join dashboards db on db.id = w.dashboard_id
      where w.id = $1 and db.id = $2`,
    [widgetId, dashboardId],
  )).rows[0] as WidgetRow | undefined
  if (!w) throw new Error('Widget não encontrado neste painel.')

  // Autoridade do acesso é aqui, não no cliente.
  if (!(await canQuery(user, String(w.dataset_id)))) {
    throw new Error('Você não tem acesso ao conjunto de dados deste widget.')
  }

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive, f.label from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [w.dataset_id],
  )).rows as { key: string; type: FieldType; sensitive: boolean; label: string }[]

  // Mesmo caminho do /query: campos sensíveis mascarados para não-admin.
  const compiled = compileQuery(
    { ...def, dataset: w.dataset_slug },
    fields,
    { admin: user.roles.includes('admin'), glob: parquetGlob(datasetDir(user.tenant, w.dataset_slug)) },
  )
  const result = await duckQuery(compiled.sql, compiled.params, { timeoutMs: 30_000, adhoc: true })

  if (!result.rows.length) {
    return {
      headline: 'Sem dados no recorte atual — não há o que analisar.',
      bullets: [], tone: 'neutral',
      provider: '-', model: '-', tookMs: 0, cached: false,
    }
  }

  const hash = createHash('sha256')
    .update(JSON.stringify({ cols: result.columns, rows: result.rows }))
    .digest('hex')

  const hit = cache.get(widgetId)
  if (!force && hit?.hash === hash) return { ...hit.insight, cached: true }

  const provider = activeProvider(user.tenant)
  if (!provider?.isConfigured()) {
    throw new Error('IA não configurada. Um administrador precisa cadastrar um provedor em Administração › Provedores de IA.')
  }

  // Teto de linhas no prompt: resultado de widget já vem agregado (8 a 100
  // linhas), mas uma tabela pode passar disso — e não vale gastar contexto.
  const MAX_ROWS = 60
  const contexto = {
    titulo: w.title,
    tipo: w.type,
    conjunto: w.dataset_name,
    colunas: result.columns,
    linhas: result.rows.slice(0, MAX_ROWS),
    ...(result.rows.length > MAX_ROWS
      ? { observacao: `mostrando ${MAX_ROWS} de ${result.rows.length} linhas` }
      : {}),
  }

  const started = Date.now()
  const turn = await provider.chat(PROMPT, [{
    role: 'user',
    content: `Analise este gráfico:\n\n${JSON.stringify(contexto, null, 1)}`,
  }], [])

  const parsed = parseInsight(turn.text)
  const insight: WidgetInsight = {
    // Se o JSON não veio, o texto do modelo ainda serve como headline — melhor
    // que engolir a resposta e mostrar erro.
    headline: parsed?.headline ?? (turn.text.trim().slice(0, 280) || 'Não consegui analisar este gráfico.'),
    bullets: parsed?.bullets ?? [],
    tone: (parsed && TONES.has(parsed.tone) ? parsed.tone : 'neutral') as WidgetInsight['tone'],
    provider: provider.name,
    model: provider.model,
    tookMs: Date.now() - started,
    cached: false,
  }

  remember(widgetId, hash, insight)
  return insight
}
