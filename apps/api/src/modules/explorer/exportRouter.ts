// Export CSV/Excel do Explorador — roda o MESMO compilador/permissões do
// query endpoint (sensíveis mascarados para não-admins) sobre o lake.
// CSV: separador ';' + BOM (abre certo no Excel pt-BR). XLSX: exceljs.
import { Router } from 'express'
import type { QueryDef, FieldType } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { canExport } from '../../core/access.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'

export const exportRouter = Router()

const MAX_EXPORT_ROWS = 100_000

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

exportRouter.post('/:slug/export', requireAuth(), async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  const format = String(req.query.format || 'csv')
  if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'format deve ser csv ou xlsx.' })

  const ds = (await db.query(
    `select d.id, d.slug, d.name, t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })

  // Exportar exige acesso de leitura + permissão de export na concessão.
  if (!(await canExport(req.user!, String(ds.id)))) {
    return res.status(403).json({ error: 'Você não tem permissão para exportar este conjunto de dados.' })
  }

  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) {
    return res.status(409).json({ error: 'Este conjunto ainda não foi sincronizado com o lake.' })
  }

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive, f.label from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean; label: string }[]
  const labelByKey = new Map(fields.map((f) => [f.key, f.label]))

  try {
    const def = (req.body ?? {}) as QueryDef
    const admin = !!req.user?.roles.includes('admin')
    const compiled = compileQuery(
      { ...def, dataset: String(ds.slug), limit: MAX_EXPORT_ROWS, offset: 0 },
      fields,
      { admin, glob: parquetGlob(dir) },
    )
    const { columns, rows } = await duckQuery(compiled.sql, compiled.params)
    const headers = columns.map((c) => labelByKey.get(c) ?? c)
    const filename = `${ds.slug}-${new Date().toISOString().slice(0, 10)}.${format}`
    await audit(req, 'datasets.export', { type: 'dataset', id: String(ds.slug) }, { format, rows: rows.length })

    if (format === 'csv') {
      const lines = [headers.map(csvCell).join(';')]
      for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(';'))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send('﻿' + lines.join('\r\n')) // BOM → Excel abre com acentuação certa
      return
    }

    // XLSX — import tardio (lib pesada, só carrega quando alguém exporta).
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet(String(ds.name).slice(0, 31) || 'Dados')
    sheet.addRow(headers)
    sheet.getRow(1).font = { bold: true }
    for (const row of rows) sheet.addRow(columns.map((c) => row[c] ?? null))
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    await wb.xlsx.write(res)
    res.end()
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})
