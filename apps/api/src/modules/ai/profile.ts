// ─────────────────────────────────────────────────────────────────────────
// Perfil automático de um conjunto — o "olhar a tabela antes de consultar"
// que um analista faz e o assistente não fazia (27/11/2026).
//
// Para cada campo visível: tipo, % de nulos, distintos (aproximado), mínimo e
// máximo; para campos de texto com poucos valores, os valores e quantas
// linhas têm cada um; para os de muitos, três exemplos — é o que mostra o
// formato ("A || B", "ISA_…", "1000-01-01") antes de filtrar errado.
//
// Vale para QUALQUER conjunto, inclusive o publicado hoje: é lido do Parquet
// na primeira vez que o assistente abre o conjunto e guardado em memória até
// a próxima carga (a chave inclui a data da última sincronização).
//
// Campo SENSÍVEL não tem valor nenhum no perfil — nem mínimo, nem exemplo:
// tudo isto vai para o provedor de IA, fora da empresa (SEG-05).
// ─────────────────────────────────────────────────────────────────────────
import { config } from '../../core/config.js'
import { duckQuery } from '../query/duck.js'

export interface CampoDoPerfil {
  key: string
  type: string
  sensitive?: boolean
}

export interface PerfilCampo {
  key: string
  tipo: string
  nulos_pct?: number
  distintos?: number
  min?: string | null
  max?: string | null
  /** Todos os valores (campo de poucos valores), com as linhas de cada um. */
  valores?: { valor: unknown; linhas: number }[]
  /** Três exemplos (campo de muitos valores), para mostrar o formato. */
  exemplos?: unknown[]
  sensivel?: true
}

export interface PerfilConjunto {
  linhas: number
  campos: PerfilCampo[]
  /** Campos cujo distinto ≈ total de linhas: candidatos a identificar a linha. */
  chave_provavel: string[]
  erro?: string
}

// Até aqui de distintos, o campo de texto mostra todos os valores.
const MAX_VALORES = 30
// No máximo tantos campos recebem a lista de valores (cada um é uma varredura
// da coluna; colunar e rápida, mas não de graça).
const MAX_CAMPOS_COM_VALORES = 20
const MAX_CACHE = 300
const cache = new Map<string, PerfilConjunto>()

const qid = (s: string) => `"${s.replace(/"/g, '""')}"`
const curto = (v: unknown) => (typeof v === 'string' && v.length > 80 ? `${v.slice(0, 79)}…` : v)

/** Chave do cache: muda quando o conjunto recarrega. */
export function chavePerfil(id: string, lastSyncAt: unknown, rowCount: unknown): string {
  const sync = lastSyncAt instanceof Date ? lastSyncAt.toISOString() : String(lastSyncAt ?? '')
  return `${id}|${sync}|${rowCount ?? ''}`
}

export async function perfilDoConjunto(chave: string, glob: string, campos: CampoDoPerfil[]): Promise<PerfilConjunto> {
  const salvo = cache.get(chave)
  if (salvo) return salvo
  const perfil = await calcula(glob, campos)
  if (!perfil.erro) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
    cache.set(chave, perfil)
  }
  return perfil
}

async function calcula(glob: string, campos: CampoDoPerfil[]): Promise<PerfilConjunto> {
  const opts = { timeoutMs: config.duck.queryTimeoutMs, adhoc: true }
  const src = `read_parquet('${glob}')`
  const abertos = campos.filter((c) => !c.sensitive)
  const sensiveis: PerfilCampo[] = campos.filter((c) => c.sensitive).map((c) => ({ key: c.key, tipo: c.type, sensivel: true }))

  try {
    // Só o que o arquivo tem de fato (um campo novo no catálogo antes da carga
    // não pode derrubar o perfil).
    const noArquivo = new Set((await duckQuery(`describe select * from ${src}`, [], opts)).rows.map((r) => String(r.column_name)))
    const usar = abertos.filter((c) => noArquivo.has(c.key))
    const total = Number((await duckQuery(`select count(*) as n from ${src}`, [], opts)).rows[0]?.n ?? 0)
    if (!usar.length || !total) {
      return { linhas: total, campos: [...usar.map((c) => ({ key: c.key, tipo: c.type })), ...sensiveis], chave_provavel: [] }
    }

    const resumo = (await duckQuery(`summarize select ${usar.map((c) => qid(c.key)).join(', ')} from ${src}`, [], opts)).rows
    const porNome = new Map(resumo.map((r) => [String(r.column_name), r]))

    const saida: PerfilCampo[] = []
    let comValores = 0
    for (const c of usar) {
      const r = porNome.get(c.key)
      const distintos = r ? Math.min(Number(r.approx_unique ?? 0), total) : undefined
      const p: PerfilCampo = {
        key: c.key,
        tipo: c.type,
        nulos_pct: r ? Math.round(Number(String(r.null_percentage ?? '0').replace('%', '')) * 10) / 10 : undefined,
        distintos,
        min: r?.min == null ? null : String(curto(r.min)),
        max: r?.max == null ? null : String(curto(r.max)),
      }
      const texto = c.type === 'text' || c.type === 'bool'
      if (texto && distintos != null && comValores < MAX_CAMPOS_COM_VALORES) {
        comValores++
        if (distintos <= MAX_VALORES) {
          const v = (await duckQuery(
            `select ${qid(c.key)} as valor, count(*) as linhas from ${src} group by 1 order by 2 desc limit ${MAX_VALORES + 1}`,
            [], opts,
          )).rows
          p.valores = v.map((x) => ({ valor: curto(x.valor), linhas: Number(x.linhas) }))
        } else {
          const v = (await duckQuery(
            `select distinct ${qid(c.key)} as valor from ${src} where ${qid(c.key)} is not null limit 3`, [], opts,
          )).rows
          p.exemplos = v.map((x) => curto(x.valor))
        }
        // Mínimo e máximo de texto não dizem nada útil e gastam espaço.
        delete p.min; delete p.max
      }
      saida.push(p)
    }
    const chave_provavel = saida
      .filter((p) => p.distintos != null && total > 1 && p.distintos >= total * 0.98 && (p.nulos_pct ?? 0) === 0)
      .map((p) => p.key)
      .slice(0, 3)
    return { linhas: total, campos: [...saida, ...sensiveis], chave_provavel }
  } catch (e) {
    return {
      linhas: 0, campos: [...abertos.map((c) => ({ key: c.key, tipo: c.type })), ...sensiveis],
      chave_provavel: [], erro: `Perfil indisponível: ${(e as Error).message}`,
    }
  }
}

/** Para os testes. */
export function limpaCachePerfil(): void { cache.clear() }
