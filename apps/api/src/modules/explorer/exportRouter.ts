// Export CSV/Excel do Explorador — roda o MESMO compilador/permissões do
// query endpoint (sensíveis mascarados para não-admins) sobre o lake.
// CSV: separador ';' + BOM (abre certo no Excel pt-BR). XLSX: exceljs.
//
// ── Por que isto é escrito em STREAMING dos dois lados ───────────────────
// A versão anterior materializava todas as linhas num array, montava o CSV
// inteiro numa única string e só então respondia. O pico de memória crescia
// junto com o resultado: 1 milhão de linhas passava de 2 GB de heap, e como o
// Node não tem `--max-old-space-size` definido aqui, o PROCESSO morria antes de
// o container chegar perto do seu limite. Processo morto = healthcheck falha =
// a stack cai. Um export derrubava o hub para todo mundo.
//
// Havia ainda um teto que MENTIA: pedia-se 100 mil linhas, o compilador cortava
// em 10 mil e o arquivo saía truncado sem avisar ninguém. Arquivo truncado em
// silêncio é pior que erro — vira decisão errada tomada com confiança.
//
// Só arrumar o servidor não bastava: o navegador fazia `await r.blob()`, que
// junta o arquivo TODO na memória da aba antes de salvar. Por isso existem dois
// caminhos aqui:
//
//   POST /:slug/export           → responde em streaming. É o caminho de script
//                                  (curl -o arquivo.csv), onde não há aba.
//   POST /:slug/export/ticket    → devolve um ticket de uso único (60 s)
//   GET  /:slug/export?ticket=…  → o MESMO streaming, mas alcançável por
//                                  navegação. O navegador grava direto em
//                                  disco, sem passar pela memória da aba.
//
// O ticket existe porque download nativo só acontece em GET/navegação, e
// navegação não carrega cabeçalho Authorization. Ele é aleatório de 32 bytes,
// vale uma vez, expira em 60 s e carrega o usuário que o pediu — o mesmo
// padrão de URL assinada de qualquer storage.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import type { QueryDef, FieldType, SessionUser } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { config } from '../../core/config.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { canExport } from '../../core/access.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery, duckStream } from '../query/duck.js'

export const exportRouter = Router()

// Teto DO FORMATO, não nosso: uma planilha .xlsx não comporta mais que
// 1.048.576 linhas, contando o cabeçalho. Não dá para contornar — o arquivo
// simplesmente não abre. Por isso o XLSX confere ANTES de começar a responder,
// enquanto ainda é possível devolver um erro honesto em vez de um arquivo
// quebrado. O CSV não tem teto nenhum.
const XLSX_MAX_DATA_ROWS = 1_048_575

const TICKET_TTL_MS = 60_000

interface Ticket {
  user: SessionUser
  slug: string
  format: 'csv' | 'xlsx'
  def: QueryDef
  expiresAt: number
}
const tickets = new Map<string, Ticket>()

function purgeTickets(): void {
  const now = Date.now()
  for (const [id, t] of tickets) if (t.expiresAt < now) tickets.delete(id)
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  // Tipos aninhados (lista, struct) viram JSON em vez de "[object Object]".
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// Escreve respeitando a contrapressão: se o socket encheu, espera o 'drain'
// antes de pedir o próximo chunk ao motor. É isto que mantém a memória
// constante quando o cliente lê mais devagar que o DuckDB produz.
function write(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve()
  return new Promise((resolve) => res.once('drain', resolve))
}

class ExportError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

interface Prepared {
  ds: { id: string; slug: string; name: string; tenant_slug: string }
  fields: { key: string; type: FieldType; sensitive: boolean; label: string }[]
  dir: string
}

// Tudo que precisa ser verificado ANTES de responder: existência, permissão,
// sincronização. Igual para os dois caminhos (POST direto e ticket).
async function prepare(user: SessionUser, slug: string): Promise<Prepared> {
  if (!isDbAvailable()) throw new ExportError(503, 'Banco de metadados indisponível.')

  const ds = (await db.query(
    `select d.id, d.slug, d.name, t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [user.tenant, slug],
  )).rows[0]
  if (!ds) throw new ExportError(404, 'Conjunto de dados não encontrado.')

  // Exportar exige acesso de leitura + permissão de export na concessão.
  if (!(await canExport(user, String(ds.id)))) {
    throw new ExportError(403, 'Você não tem permissão para exportar este conjunto de dados.')
  }

  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) {
    throw new ExportError(409, 'Este conjunto ainda não foi sincronizado com o lake.')
  }

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive, f.label from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [ds.id],
  )).rows as Prepared['fields']

  return { ds, fields, dir }
}

async function runExport(
  req: Request, res: Response, user: SessionUser, slug: string, format: 'csv' | 'xlsx', def: QueryDef,
): Promise<void> {
  const { ds, fields, dir } = await prepare(user, slug)
  const labelByKey = new Map(fields.map((f) => [f.key, f.label]))

  const compiled = compileQuery(
    { ...def, dataset: String(ds.slug), offset: 0 },
    fields,
    { admin: user.roles.includes('admin'), glob: parquetGlob(dir), maxLimit: null }, // null = tudo
  )

  // XLSX: confere o tamanho antes de escrever o primeiro byte. Depois que a
  // resposta começa não há como voltar atrás e devolver um erro.
  if (format === 'xlsx' && compiled.countSql) {
    const total = Number(
      (await duckQuery(compiled.countSql, compiled.countParams, {
        timeoutMs: config.duck.queryTimeoutMs, lane: 'export',
      })).rows[0]?.n ?? 0,
    )
    if (total > XLSX_MAX_DATA_ROWS) {
      throw new ExportError(413,
        `Este recorte tem ${total.toLocaleString('pt-BR')} linhas e uma planilha Excel comporta no máximo ` +
        `${XLSX_MAX_DATA_ROWS.toLocaleString('pt-BR')}. Exporte em CSV (sem limite) ou aplique filtros.`)
    }
  }

  const filename = `${ds.slug}-${new Date().toISOString().slice(0, 10)}.${format}`
  // O cliente pode fechar a aba no meio de um export de milhões de linhas.
  let clientGone = false
  res.on('close', () => { if (!res.writableEnded) clientGone = true })

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    // Sem Content-Length: o tamanho só se conhece no fim. A resposta sai em
    // chunked encoding, que é o certo para conteúdo gerado sob demanda.

    let wroteHeader = false
    const { rowCount, aborted } = await duckStream(
      compiled.sql, compiled.params,
      async (rows, columns) => {
        if (!wroteHeader) {
          const head = columns.map((c) => csvCell(labelByKey.get(c) ?? c)).join(';')
          await write(res, '﻿' + head + '\r\n') // BOM → acentuação certa no Excel
          wroteHeader = true
        }
        const lines: string[] = []
        for (const row of rows) lines.push(row.map(csvCell).join(';'))
        await write(res, lines.join('\r\n') + '\r\n')
      },
      { lane: 'export', aborted: () => clientGone },
    )

    // Resultado vazio: ainda assim o arquivo precisa ter cabeçalho, senão abre
    // em branco e parece falha do sistema.
    if (!wroteHeader) {
      await write(res, '﻿' + fields.map((f) => csvCell(f.label ?? f.key)).join(';') + '\r\n')
    }
    res.end()
    if (!aborted) {
      await audit(req, 'datasets.export', { type: 'dataset', id: String(ds.slug) }, { format, rows: rowCount })
    }
    return
  }

  // XLSX — import tardio (lib pesada, só carrega quando alguém exporta).
  // WorkbookWriter escreve direto no socket, linha a linha: nada de montar a
  // planilha inteira em memória como antes.
  const ExcelJS = (await import('exceljs')).default
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    useSharedStrings: false, // a tabela de strings compartilhadas viveria em memória
  })
  const sheet = wb.addWorksheet(String(ds.name).slice(0, 31) || 'Dados')

  let wroteHeader = false
  const { rowCount, aborted } = await duckStream(
    compiled.sql, compiled.params,
    (rows, columns) => {
      if (!wroteHeader) {
        const head = sheet.addRow(columns.map((c) => labelByKey.get(c) ?? c))
        head.font = { bold: true }
        head.commit()
        wroteHeader = true
      }
      for (const row of rows) {
        sheet.addRow(row.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v))).commit()
      }
    },
    { lane: 'export', aborted: () => clientGone },
  )
  if (!wroteHeader) sheet.addRow(fields.map((f) => f.label ?? f.key)).commit()
  sheet.commit()
  await wb.commit()
  if (!aborted) {
    await audit(req, 'datasets.export', { type: 'dataset', id: String(ds.slug) }, { format, rows: rowCount })
  }
}

// Se a resposta já começou não há status para trocar. O jeito honesto de
// sinalizar falha num arquivo pela metade é derrubar a conexão: o cliente vê
// download incompleto em vez de um CSV truncado que parece íntegro.
function failExport(res: Response, e: unknown): void {
  if (res.headersSent) { res.destroy(e as Error); return }
  const status = e instanceof ExportError ? e.status : 400
  res.status(status).json({ error: (e as Error).message })
}

const fmtOf = (v: unknown): 'csv' | 'xlsx' | null =>
  v === 'xlsx' ? 'xlsx' : v === 'csv' || v === undefined || v === '' ? 'csv' : null

// ── Caminho de script: POST autenticado, resposta em streaming ───────────
exportRouter.post('/:slug/export', requireAuth(), async (req, res) => {
  const format = fmtOf(req.query.format)
  if (!format) return res.status(400).json({ error: 'format deve ser csv ou xlsx.' })
  try {
    await runExport(req, res, req.user!, req.params.slug, format, (req.body ?? {}) as QueryDef)
  } catch (e) { failExport(res, e) }
})

// ── Caminho do navegador: ticket + navegação ─────────────────────────────
exportRouter.post('/:slug/export/ticket', requireAuth(), async (req, res) => {
  const format = fmtOf(req.query.format)
  if (!format) return res.status(400).json({ error: 'format deve ser csv ou xlsx.' })
  try {
    // Valida agora o que dá para validar agora: assim um erro de permissão
    // aparece como mensagem na tela, não como download que falha sozinho.
    await prepare(req.user!, req.params.slug)
    purgeTickets()
    const id = randomBytes(32).toString('base64url')
    tickets.set(id, {
      user: req.user!, slug: req.params.slug, format,
      def: (req.body ?? {}) as QueryDef, expiresAt: Date.now() + TICKET_TTL_MS,
    })
    res.json({ ticket: id, expiresInSec: TICKET_TTL_MS / 1000 })
  } catch (e) { failExport(res, e) }
})

exportRouter.get('/:slug/export', async (req, res) => {
  purgeTickets()
  const id = String(req.query.ticket ?? '')
  const t = id ? tickets.get(id) : undefined
  // Uso único: consome ANTES de executar, para um link reenviado não render
  // um segundo export.
  if (t) tickets.delete(id)
  if (!t || t.expiresAt < Date.now() || t.slug !== req.params.slug) {
    return res.status(401).json({ error: 'Link de download inválido ou expirado. Peça o export de novo.' })
  }
  // O ticket É a credencial: repõe o usuário para a auditoria registrar quem
  // baixou, e não um download anônimo.
  req.user = t.user
  try {
    await runExport(req, res, t.user, t.slug, t.format, t.def)
  } catch (e) { failExport(res, e) }
})
