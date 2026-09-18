// ─────────────────────────────────────────────────────────────────────────
// Quem pode mudar COMO uma FONTE atualiza.
//
// Mexer no modo, nas chaves incrementais, na identidade da linha ou na
// cadência de um conjunto de FONTE tem duas consequências que nenhuma outra
// tela do hub tem:
//   • carga nos bancos de PRODUÇÃO — uma cadência de minutos numa chave sem
//     índice vira varredura completa da tabela centenas de vezes por dia;
//   • integridade do lake — trocar a chave ou o piso zera o watermark e manda
//     o conjunto recarregar do começo.
// Por isso essas mudanças ficam com o admin MASTER, enquanto o resto da
// administração continua com 'admin'.
//
// Conjuntos CALCULADOS ficam de fora: eles rodam SQL sobre o lake, não tocam
// fonte nenhuma, e continuam com a permissão que sempre tiveram ('editor').
// A distinção aqui é exatamente essa — quem encosta na produção e quem não.
//
// A checagem é sempre pelo `kind` gravado no BANCO, nunca por algo que o
// cliente mande: o front não tem como se declarar "calculado" para escapar.
// ─────────────────────────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from 'express'
import { db } from '../../db/pool.js'
import { MASTER_ONLY_MESSAGE } from '../auth/middleware.js'

/** true quando o conjunto ingere de uma fonte (ou seja, não é calculado). */
export async function isSourceDataset(datasetId: string): Promise<boolean | null> {
  const row = (await db.query(`select kind from datasets where id = $1`, [datasetId])).rows[0]
  if (!row) return null
  return String(row.kind) !== 'derived'
}

/**
 * Middleware para rotas de UM conjunto (`/:id/...`): exige master se o
 * conjunto for de fonte; deixa passar se for calculado.
 */
export async function requireMasterOnSource(req: Request, res: Response, next: NextFunction): Promise<void> {
  const source = await isSourceDataset(req.params.id)
  if (source === null) { res.status(404).json({ error: 'Conjunto de dados não encontrado.' }); return }
  if (source && !req.user?.master) { res.status(403).json({ error: MASTER_ONLY_MESSAGE }); return }
  next()
}

/**
 * Para operações em LOTE (aplicar agendamento, padronizar em massa): devolve
 * quantos dos ids são conjuntos de fonte. Zero = a operação toca só
 * calculados e não precisa de master.
 *
 * Um único conjunto de fonte no lote já exige master — deixar passar "o resto"
 * e recusar só a fonte daria um sucesso parcial silencioso, que é pior: quem
 * clicou acha que aplicou em tudo.
 */
export async function countSourcesAmong(datasetIds: string[]): Promise<number> {
  if (!datasetIds.length) return 0
  const r = await db.query(
    `select count(*)::int as n from datasets where id = any($1::uuid[]) and kind <> 'derived'`,
    [datasetIds],
  )
  return Number(r.rows[0]?.n ?? 0)
}

/** Quantos conjuntos de FONTE seguem um agendamento — editar/apagar um
 *  agendamento muda a cadência de todos eles de uma vez. */
export async function countSourcesUsingSchedule(scheduleId: string): Promise<number> {
  const r = await db.query(
    `select count(*)::int as n from datasets where schedule_id = $1 and kind <> 'derived'`,
    [scheduleId],
  )
  return Number(r.rows[0]?.n ?? 0)
}

/** 403 padrão quando um lote/agendamento encosta em conjunto de fonte. */
export function denyMaster(res: Response, extra?: string): void {
  res.status(403).json({ error: extra ? `${MASTER_ONLY_MESSAGE} ${extra}` : MASTER_ONLY_MESSAGE })
}

// As duas abaixo existem como MIDDLEWARE, e não como um `if` no corpo da rota,
// por um motivo prático: assim o nível de permissão de cada rota fica visível
// na própria definição dela — e verificável de fora, lendo a pilha que o
// Express montou (ver dev/permissionsSmoke.ts). Guard escondido no meio do
// corpo é guard que ninguém percebe faltar na rota seguinte.

/**
 * Rotas que mexem num AGENDAMENTO existente (`/:id` editar/apagar): exige
 * master se algum conjunto de FONTE segue esse agendamento — editar o
 * intervalo ou apagá-lo muda a cadência de todos eles de uma vez.
 */
export async function requireMasterOnScheduleMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const fontes = await countSourcesUsingSchedule(req.params.id)
  if (fontes > 0 && !req.user?.master) {
    denyMaster(res, `Este agendamento rege ${fontes} conjunto(s) de fonte.`)
    return
  }
  next()
}

/**
 * Rotas em LOTE que recebem `datasetIds` no corpo (aplicar/retirar
 * agendamento): exige master se QUALQUER um deles for conjunto de fonte.
 */
export async function requireMasterOnDatasetBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ids = Array.isArray(req.body?.datasetIds) ? (req.body.datasetIds as unknown[]).map(String) : []
  const fontes = await countSourcesAmong(ids)
  if (fontes > 0 && !req.user?.master) {
    denyMaster(res, `${fontes} do(s) conjunto(s) selecionado(s) é/são de fonte.`)
    return
  }
  next()
}
