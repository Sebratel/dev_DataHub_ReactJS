// Publicação de um conjunto no Databricks, depois da materialização.
//
// Regra que manda em tudo aqui: isto é BEST-EFFORT. O Data Hub já terminou o
// trabalho dele quando esta função é chamada — o dado está no lake, o catálogo
// está atualizado, as telas já enxergam. Se o Databricks estiver fora, a conta
// vencida ou o token errado, isso não pode voltar como erro de sincronização.
// O envio falha, fica registrado, alerta, e o próximo ciclo tenta de novo.
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { db } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { consolidar } from './consolidate.js'
import { criarDiretorio, enviarArquivo, DatabricksError } from './client.js'
import { montarManifesto } from './manifest.js'
import type { RecencyKey } from '../sync/recency.js'

// `dt` e `HHmm` organizam as pastas em hora de São Paulo — é como alguém
// procura "o envio das 8 da manhã". O servidor pode rodar em UTC, então o fuso
// é explícito; o conteúdo dos arquivos continua em UTC.
function dataHoraSaoPaulo(d: Date): { dt: string; hhmm: string } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '00'
  return { dt: `${p('year')}-${p('month')}-${p('day')}`, hhmm: `${p('hour')}${p('minute')}` }
}

/**
 * O hub não tem o conceito de medalhão no banco — tem `kind`, que já separa o
 * que veio da fonte do que foi calculado. Promover um calculado a 'ouro' é
 * julgamento de quem modela, e por isso é um campo que se preenche à mão.
 */
export function camadaDe(kind: string, layer: string | null): string {
  if (layer) return layer
  return kind === 'derived' ? 'prata' : 'bronze'
}

/** O slug vira nome de tabela Delta, onde hífen não é identificador válido. */
export function slugDeTabela(slug: string): string {
  return slug.replace(/-/g, '_')
}

interface LinhaDataset {
  id: string
  slug: string
  tenant_slug: string
  kind: string
  connection_id: string
  dedupe_keys: string[] | null
  incremental_key: string | null
  incremental_key_2: string | null
  databricks_enabled: boolean
  databricks_mode: string
  databricks_layer: string | null
}

async function registrar(linha: {
  runId: string; datasetId: string; slug: string; status: string; mode: string
  sourceParts?: number; rowCount?: number; fileSize?: number; filePath?: string
  attempts: number; erro?: string; inicio: Date
}): Promise<void> {
  await db.query(
    `insert into databricks_sync_runs
       (id, dataset_id, dataset_slug, status, mode, source_parts, row_count,
        file_size_bytes, file_path, attempts, error_message, started_at, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
    [
      linha.runId, linha.datasetId, linha.slug, linha.status, linha.mode,
      linha.sourceParts ?? null, linha.rowCount ?? null, linha.fileSize ?? null,
      linha.filePath ?? null, linha.attempts, linha.erro ?? null, linha.inicio,
    ],
  )
}

// Duas falhas seguidas no mesmo conjunto deixam de ser azar e viram defeito: ou
// a credencial venceu, ou a permissão mudou, ou o volume sumiu. Nenhum desses
// se conserta sozinho, então alguém precisa saber.
async function alertarSeReincidente(slug: string): Promise<void> {
  const { rows } = await db.query(
    `select status from databricks_sync_runs where dataset_slug = $1
      order by started_at desc limit 2`,
    [slug],
  )
  if (rows.length === 2 && rows.every((r) => r.status === 'FAILED')) {
    console.error(
      `[databricks][ALERTA] ${slug}: 2 envios seguidos falharam. ` +
      'Confira credencial, permissão no volume e se o workspace está no ar.',
    )
  }
}

export interface ResultadoPublicacao {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED'
  runId?: string
  /** Por que foi pulado — só em SKIPPED. */
  reason?: string
  rowCount?: number
  sourceParts?: number
  filePath?: string
  attempts?: number
  warning?: string
  error?: string
}

/**
 * Publica o conjunto se ele estiver habilitado. Nunca lança: o chamador é o fim
 * de uma materialização bem-sucedida, e nada aqui pode desfazer isso.
 *
 * Devolve o que aconteceu — o gancho ignora, o envio manual (tela/piloto) usa
 * para dizer ao operador se foi, quantas linhas e para onde.
 *
 * @param extractedAt quando a materialização que gerou estes dados terminou.
 */
export async function publicarDataset(
  datasetId: string, extractedAt: Date,
): Promise<ResultadoPublicacao> {
  if (!config.databricks.enabled) {
    return { status: 'SKIPPED', reason: 'DATABRICKS_SYNC_ENABLED está desligado.' }
  }

  let ds: LinhaDataset | undefined
  try {
    ds = (await db.query(
      `select d.id, d.slug, t.slug as tenant_slug, d.kind, d.connection_id,
              d.dedupe_keys, d.incremental_key, d.incremental_key_2,
              d.databricks_enabled, d.databricks_mode, d.databricks_layer
         from datasets d join tenants t on t.id = d.tenant_id where d.id = $1`,
      [datasetId],
    )).rows[0] as LinhaDataset | undefined
  } catch (e) {
    console.error(`[databricks] não consegui ler o conjunto ${datasetId}: ${(e as Error).message}`)
    return { status: 'FAILED', error: (e as Error).message }
  }
  if (!ds) return { status: 'SKIPPED', reason: 'Conjunto não encontrado.' }
  if (!ds.databricks_enabled) {
    return { status: 'SKIPPED', reason: 'Conjunto sem "Publicar no Databricks" ligado.' }
  }

  const runId = randomUUID()
  const inicio = new Date()
  const { dt, hhmm } = dataHoraSaoPaulo(inicio)
  const camada = camadaDe(ds.kind, ds.databricks_layer)
  const dedupeKeys = (ds.dedupe_keys ?? []).filter(Boolean)
  let tmpDir: string | null = null

  try {
    // As chaves de recência seguem a MESMA regra da compactação: só as
    // temporais decidem, e o tipo de cada uma importa (ver recencyExpression).
    const tipos = new Map(
      (await db.query(
        'select key, type from dataset_fields where dataset_id = $1', [ds.id],
      )).rows.map((r) => [String(r.key), String(r.type)]),
    )
    const recencyKeys: RecencyKey[] = [ds.incremental_key, ds.incremental_key_2]
      .filter(Boolean).map(String)
      .map((key) => ({ key, isDate: tipos.get(key) === 'date' }))

    const cons = await consolidar({
      tenantSlug: ds.tenant_slug, slug: ds.slug, dedupeKeys, recencyKeys, runId, hhmm,
    })
    tmpDir = cons.tmpDir
    if (cons.warning) console.warn(`[databricks] ${cons.warning}`)

    const base = `${config.databricks.volumePath}/${camada}/${ds.slug}/dt=${dt}`
    await criarDiretorio(base)

    let tentativas = 0
    let bytes = 0
    const arquivos = cons.files.map((local) => ({
      local, volume: `${base}/${local.split(/[\\/]/).pop()}`,
    }))
    for (const a of arquivos) {
      const conteudo = readFileSync(a.local)
      bytes += conteudo.byteLength
      const r = await enviarArquivo(a.volume, conteudo)
      tentativas += r.attempts
    }

    // O manifesto vai por ÚLTIMO, sempre: é ele que autoriza o job a carregar.
    const manifesto = await montarManifesto({
      runId, slug: ds.slug, layer: camada, sourceConnection: ds.connection_id,
      mode: ds.databricks_mode, dedupeKeys, sourceParts: cons.sourceParts,
      rowCount: cons.rowCount, columns: cons.columns, renamed: cons.renamed,
      warning: cons.warning, sourceTimezone: config.databricks.sourceTimezone,
      arquivos, extractedAt,
    })
    const caminhoManifesto = `${base}/${hhmm}_${runId}.manifest.json`
    const r = await enviarArquivo(
      caminhoManifesto, Buffer.from(JSON.stringify(manifesto, null, 2), 'utf8'),
      'application/json',
    )
    tentativas += r.attempts

    await registrar({
      runId, datasetId: ds.id, slug: ds.slug, status: 'SUCCESS', mode: ds.databricks_mode,
      sourceParts: cons.sourceParts, rowCount: cons.rowCount, fileSize: bytes,
      filePath: arquivos[0]?.volume, attempts: tentativas, inicio,
    })
    console.log(
      `[databricks] ${ds.slug}: ${cons.rowCount} linha(s) de ${cons.sourceParts} parte(s) ` +
      `enviadas para ${camada}/${ds.slug}/dt=${dt}.`,
    )
    return {
      status: 'SUCCESS', runId, rowCount: cons.rowCount, sourceParts: cons.sourceParts,
      filePath: arquivos[0]?.volume, attempts: tentativas, warning: cons.warning,
    }
  } catch (e) {
    const erro = e instanceof DatabricksError ? e.message : (e as Error).message
    console.error(`[databricks] ${ds.slug}: envio falhou — ${erro}`)
    try {
      await registrar({
        runId, datasetId: ds.id, slug: ds.slug, status: 'FAILED', mode: ds.databricks_mode,
        attempts: 0, erro: erro.slice(0, 500), inicio,
      })
      await alertarSeReincidente(ds.slug)
    } catch (e2) {
      console.error(`[databricks] falhei até ao registrar a falha: ${(e2 as Error).message}`)
    }
    return { status: 'FAILED', runId, error: erro }
  } finally {
    // O consolidado é descartável: ele existe só para a viagem. Deixá-lo no
    // disco encheria o volume em dias, 13 envios por conjunto por dia.
    if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* segue */ }
  }
}
