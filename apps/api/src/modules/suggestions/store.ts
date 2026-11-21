// ─────────────────────────────────────────────────────────────────────────
// Sugestões de melhoria da plataforma (item 2 de 19/11/2026).
//
// O MESMO banco das sugestões do Hub Apps, do Splitters e dos demais sistemas:
// DB_Hub_Apps (MariaDB 10.0.11.171), tabelas platform_suggestions,
// platform_suggestion_votes e platform_suggestion_comments. Cada sistema vê só
// as do seu app (coluna app_id = o id do app no cadastro do Hub Apps).
// Portado de dev_ReactJS_Splitters/server/platformSuggestionsStore.js.
//
// Configuração por ambiente, como no Splitters:
//   HUB_APPS_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE — credencial do DB_Hub_Apps;
//   PLATFORM_SUGGESTIONS_APP_ID — id do Data Hub no cadastro de apps do Hub Apps;
//   PLATFORM_SUGGESTIONS_READ_ONLY — padrão true: o Data Hub só mostra, e quem
//     sugere/vota/comenta é o Hub Apps (é como o Splitters roda em produção).
//     Com false, grava direto (o usuário do banco precisa de permissão nas 3
//     tabelas).
//
// Diferença do Splitters: o voto é identificado pelo E-MAIL. Cada sistema tem
// o próprio projeto Firebase, então o uid muda de um para outro; o e-mail não.
// As datas do banco são hora local de Brasília (DATETIME sem fuso).
// ─────────────────────────────────────────────────────────────────────────
import mysql from 'mysql2/promise'

const SUGESTOES = 'platform_suggestions'
const VOTOS = 'platform_suggestion_votes'
const COMENTARIOS = 'platform_suggestion_comments'

export const STATUS_SUGESTAO = ['open', 'planned', 'in_progress', 'done', 'rejected'] as const
export type StatusSugestao = typeof STATUS_SUGESTAO[number]

export class SugestaoErro extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const limpo = (v: unknown) => String(v ?? '').trim()

interface ConfigHubApps { host: string; port: number; user: string; password: string; database: string }

export function configHubApps(): ConfigHubApps {
  return {
    host: limpo(process.env.HUB_APPS_MYSQL_HOST),
    port: Number(process.env.HUB_APPS_MYSQL_PORT) || 3306,
    user: limpo(process.env.HUB_APPS_MYSQL_USER),
    password: String(process.env.HUB_APPS_MYSQL_PASSWORD ?? ''),
    database: limpo(process.env.HUB_APPS_MYSQL_DATABASE) || 'DB_Hub_Apps',
  }
}

export const appIdSugestoes = () => limpo(process.env.PLATFORM_SUGGESTIONS_APP_ID)
export const somenteLeitura = () => limpo(process.env.PLATFORM_SUGGESTIONS_READ_ONLY).toLowerCase() !== 'false'
export const urlHubApps = () => limpo(process.env.HUB_APPS_URL) || 'https://hub-apps.sebratel.net.br'

/** O que falta para o módulo funcionar (vazio = pronto). */
export function faltaConfigurar(): string[] {
  const c = configHubApps()
  const falta: string[] = []
  if (!c.host || !c.user || !c.password) falta.push('HUB_APPS_MYSQL_HOST/USER/PASSWORD')
  if (!appIdSugestoes()) falta.push('PLATFORM_SUGGESTIONS_APP_ID')
  return falta
}

let pool: mysql.Pool | null = null
let chavePool = ''
function conexao(): mysql.Pool {
  const c = configHubApps()
  const chave = `${c.host}:${c.port}/${c.database}/${c.user}`
  // Recria se a configuração mudou (testes trocam o banco entre execuções).
  if (pool && chave === chavePool) return pool
  if (pool) void pool.end().catch(() => {})
  chavePool = chave
  pool = mysql.createPool({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
    connectionLimit: 4, charset: 'utf8mb4', dateStrings: true,
  })
  return pool
}

export async function fecharSugestoes(): Promise<void> {
  if (pool) await pool.end().catch(() => {})
  pool = null
  chavePool = ''
}

function exigeConfig(): void {
  const falta = faltaConfigurar()
  if (falta.length) throw new SugestaoErro(503, `Sugestões não configuradas: falta ${falta.join(' e ')}.`)
}

function traduzErro(e: unknown): never {
  if (e instanceof SugestaoErro) throw e
  const err = e as { code?: string; errno?: number; message?: string }
  if (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146) {
    throw new SugestaoErro(503, `As tabelas de sugestões não existem em ${configHubApps().database}.`)
  }
  if (err.code === 'ER_TABLEACCESS_DENIED_ERROR' || err.code === 'ER_DBACCESS_DENIED_ERROR' || err.errno === 1142) {
    throw new SugestaoErro(503, 'O usuário do banco do Hub Apps não tem permissão nas tabelas de sugestões.')
  }
  throw new SugestaoErro(502, `Banco do Hub Apps indisponível: ${err.message ?? String(e)}`)
}

// DATETIME do Hub Apps = hora de Brasília, sem fuso (o Brasil não tem horário de verão desde 2019).
const dataIso = (v: unknown): string | null => {
  const s = limpo(v)
  return s ? `${s.replace(' ', 'T')}-03:00` : null
}

export interface Pessoa { email: string; name: string; photoURL: string | null }
export interface Comentario { id: number; author: Pessoa; message: string; createdAt: string | null }
export interface Sugestao {
  id: number; title: string; description: string; sector: string; category: string | null
  status: StatusSugestao; author: Pessoa
  likesCount: number; dislikesCount: number; commentsCount: number; score: number
  viewerVote: 'like' | 'dislike' | null
  supporters: Pessoa[]; comments: Comentario[]
  createdAt: string | null; updatedAt: string | null
}

const pessoa = (r: Record<string, unknown>, p: string): Pessoa => ({
  email: limpo(r[`${p}_email`]).toLowerCase(),
  name: limpo(r[`${p}_name`]),
  photoURL: limpo(r[`${p}_photo_url`]) || null,
})

async function montar(c: mysql.Pool | mysql.PoolConnection, linhas: Record<string, unknown>[]): Promise<Sugestao[]> {
  const ids = linhas.map((r) => Number(r.id))
  const apoios = new Map<number, Pessoa[]>()
  const coments = new Map<number, Comentario[]>()
  if (ids.length) {
    const [v] = await c.query(
      `select suggestion_id, user_email, user_name, user_photo_url from ${VOTOS}
        where suggestion_id in (?) and vote_type = 'like' order by created_at, id`, [ids])
    for (const r of v as Record<string, unknown>[]) {
      const id = Number(r.suggestion_id)
      apoios.set(id, [...(apoios.get(id) ?? []), pessoa(r, 'user')])
    }
    const [m] = await c.query(
      `select id, suggestion_id, author_email, author_name, author_photo_url, message, created_at
         from ${COMENTARIOS} where suggestion_id in (?) order by created_at, id`, [ids])
    for (const r of m as Record<string, unknown>[]) {
      const id = Number(r.suggestion_id)
      coments.set(id, [...(coments.get(id) ?? []), {
        id: Number(r.id), author: pessoa(r, 'author'), message: limpo(r.message), createdAt: dataIso(r.created_at),
      }])
    }
  }
  return linhas.map((r) => {
    const id = Number(r.id)
    const comentarios = coments.get(id) ?? []
    const status = limpo(r.status).toLowerCase()
    const voto = limpo(r.viewer_vote)
    return {
      id, title: limpo(r.title), description: limpo(r.description), sector: limpo(r.sector),
      category: limpo(r.category) || null,
      status: (STATUS_SUGESTAO as readonly string[]).includes(status) ? status as StatusSugestao : 'open',
      author: pessoa(r, 'author'),
      likesCount: Number(r.likes_count ?? 0), dislikesCount: Number(r.dislikes_count ?? 0),
      commentsCount: Math.max(Number(r.comments_count ?? 0), comentarios.length),
      score: Number(r.score ?? 0),
      viewerVote: voto === 'like' || voto === 'dislike' ? voto : null,
      supporters: apoios.get(id) ?? [], comments: comentarios,
      createdAt: dataIso(r.created_at), updatedAt: dataIso(r.updated_at),
    }
  })
}

const SELECT = `select s.id, s.title, s.description, s.sector, s.category, s.status,
    s.author_email, s.author_name, s.author_photo_url,
    s.likes_count, s.dislikes_count, s.comments_count, s.score, s.created_at, s.updated_at,
    v.vote_type as viewer_vote
  from ${SUGESTOES} s
  left join ${VOTOS} v on v.suggestion_id = s.id and v.user_uid = ?`

async function umaSugestao(c: mysql.Pool | mysql.PoolConnection, id: number, quem: string): Promise<Sugestao> {
  const [r] = await c.query(`${SELECT} where s.id = ? and s.app_id = ?`, [quem, id, appIdSugestoes()])
  const s = (await montar(c, r as Record<string, unknown>[]))[0]
  if (!s) throw new SugestaoErro(404, 'Sugestão não encontrada.')
  return s
}

export async function listarSugestoes(quem: string, limite = 200): Promise<Sugestao[]> {
  exigeConfig()
  try {
    const c = conexao()
    const [r] = await c.query(
      `${SELECT} where s.app_id = ? order by s.score desc, s.likes_count desc, s.created_at desc limit ?`,
      [quem, appIdSugestoes(), Math.min(Math.max(limite, 1), 300)])
    return await montar(c, r as Record<string, unknown>[])
  } catch (e) { traduzErro(e) }
}

export interface Autor { email: string; name: string; picture?: string | null }

export async function criarSugestao(autor: Autor, dados: { title?: unknown; description?: unknown; sector?: unknown; category?: unknown }): Promise<Sugestao> {
  exigeConfig()
  const title = limpo(dados.title), description = limpo(dados.description), sector = limpo(dados.sector)
  const category = limpo(dados.category) || null
  if (title.length < 5) throw new SugestaoErro(400, 'O título precisa de pelo menos 5 caracteres.')
  if (description.length < 15) throw new SugestaoErro(400, 'A descrição precisa de pelo menos 15 caracteres.')
  if (sector.length < 2) throw new SugestaoErro(400, 'Informe o setor ou a área impactada.')
  try {
    const c = conexao()
    const email = autor.email.toLowerCase()
    const [res] = await c.query(
      `insert into ${SUGESTOES} (title, description, sector, app_id, category, status,
         author_uid, author_email, author_name, author_photo_url)
       values (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [title.slice(0, 191), description.slice(0, 8000), sector.slice(0, 120), appIdSugestoes(),
       category ? category.slice(0, 120) : null, email.slice(0, 128), email.slice(0, 191),
       (limpo(autor.name) || email).slice(0, 191), autor.picture ? autor.picture.slice(0, 1024) : null])
    return await umaSugestao(c, Number((res as mysql.ResultSetHeader).insertId), email)
  } catch (e) { traduzErro(e) }
}

async function existeNoApp(c: mysql.PoolConnection, id: number): Promise<void> {
  const [r] = await c.query(`select id from ${SUGESTOES} where id = ? and app_id = ? limit 1 for update`, [id, appIdSugestoes()])
  if (!(r as unknown[]).length) throw new SugestaoErro(404, 'Sugestão não encontrada.')
}

/** Mesma regra do Hub Apps: repetir o voto desfaz; votar o contrário troca; 'none' tira. */
export async function votar(autor: Autor, id: number, tipo: unknown): Promise<Sugestao> {
  exigeConfig()
  const voto = limpo(tipo).toLowerCase()
  if (!['like', 'dislike', 'none'].includes(voto)) throw new SugestaoErro(400, 'Voto inválido.')
  const c = conexao()
  let con: mysql.PoolConnection | null = null
  try {
    con = await c.getConnection()
    await con.beginTransaction()
    await existeNoApp(con, id)
    const email = autor.email.toLowerCase()
    const [r] = await con.query(`select id, vote_type from ${VOTOS} where suggestion_id = ? and user_uid = ? limit 1 for update`, [id, email])
    const atual = (r as { id: number; vote_type: string }[])[0]
    if (voto === 'none' || (atual && atual.vote_type === voto)) {
      if (atual) await con.query(`delete from ${VOTOS} where id = ?`, [atual.id])
    } else if (atual) {
      await con.query(`update ${VOTOS} set vote_type = ?, user_email = ?, user_name = ?, user_photo_url = ? where id = ?`,
        [voto, email.slice(0, 191), (limpo(autor.name) || email).slice(0, 191), autor.picture ?? null, atual.id])
    } else {
      await con.query(
        `insert into ${VOTOS} (suggestion_id, user_uid, user_email, user_name, user_photo_url, vote_type) values (?, ?, ?, ?, ?, ?)`,
        [id, email.slice(0, 128), email.slice(0, 191), (limpo(autor.name) || email).slice(0, 191), autor.picture ?? null, voto])
    }
    await con.query(
      `update ${SUGESTOES} s,
         (select coalesce(sum(vote_type = 'like'), 0) as l, coalesce(sum(vote_type = 'dislike'), 0) as d
            from ${VOTOS} where suggestion_id = ?) t
       set s.likes_count = t.l, s.dislikes_count = t.d, s.score = t.l - t.d
       where s.id = ?`, [id, id])
    await con.commit()
    return await umaSugestao(con, id, email)
  } catch (e) {
    if (con) await con.rollback().catch(() => {})
    return traduzErro(e)
  } finally {
    con?.release()
  }
}

export async function comentar(autor: Autor, id: number, mensagem: unknown): Promise<Sugestao> {
  exigeConfig()
  const texto = limpo(mensagem)
  if (texto.length < 2) throw new SugestaoErro(400, 'Comentário muito curto.')
  const c = conexao()
  let con: mysql.PoolConnection | null = null
  try {
    con = await c.getConnection()
    await con.beginTransaction()
    await existeNoApp(con, id)
    const email = autor.email.toLowerCase()
    await con.query(
      `insert into ${COMENTARIOS} (suggestion_id, author_uid, author_email, author_name, author_photo_url, message)
       values (?, ?, ?, ?, ?, ?)`,
      [id, email.slice(0, 128), email.slice(0, 191), (limpo(autor.name) || email).slice(0, 191), autor.picture ?? null, texto.slice(0, 4000)])
    await con.query(`update ${SUGESTOES} set comments_count = comments_count + 1 where id = ?`, [id])
    await con.commit()
    return await umaSugestao(con, id, email)
  } catch (e) {
    if (con) await con.rollback().catch(() => {})
    return traduzErro(e)
  } finally {
    con?.release()
  }
}

export async function mudarStatus(quem: string, id: number, status: unknown): Promise<Sugestao> {
  exigeConfig()
  const s = limpo(status).toLowerCase()
  if (!(STATUS_SUGESTAO as readonly string[]).includes(s)) throw new SugestaoErro(400, 'Status inválido.')
  try {
    const c = conexao()
    const [res] = await c.query(`update ${SUGESTOES} set status = ? where id = ? and app_id = ?`, [s, id, appIdSugestoes()])
    if (!(res as mysql.ResultSetHeader).affectedRows) throw new SugestaoErro(404, 'Sugestão não encontrada.')
    return await umaSugestao(c, id, quem.toLowerCase())
  } catch (e) { traduzErro(e) }
}
