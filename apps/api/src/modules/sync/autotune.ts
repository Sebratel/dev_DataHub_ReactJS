// ─────────────────────────────────────────────────────────────────────────
// Padronização da regra de atualização, conjunto a conjunto, a partir do que a
// TABELA DE ORIGEM realmente tem.
//
// A migration 029 deu o motor (duas chaves, identidade da linha, folga,
// compactação). O que faltava era a decisão: qual coluna é o "criado", qual é
// o "editado", e o que identifica a linha — em dezenas de conjuntos, à mão,
// um por um, na tela. Este módulo faz essa leitura no catálogo do banco de
// origem (PK, índices únicos, cobertura de índice) e devolve uma PROPOSTA por
// conjunto, com o porquê e com os riscos.
//
// Duas regras de projeto que valem mais que a esperteza da heurística:
//
//  1. Ele PROPÕE; quem aplica é o admin, item a item ou em lote. Nada muda
//     sozinho — a proposta errada num conjunto grande custa uma recarga.
//  2. Ele NUNCA propõe piso (sync_since/sync_since_days). Piso descarta
//     histórico, e isso é decisão de negócio, não de heurística.
//
// A pergunta que o diagnóstico existe para responder não é "dá para ligar
// incremental?", é "dá para ligar incremental A CADA 5 MINUTOS sem varrer a
// tabela inteira da produção 288 vezes por dia?". Por isso a cobertura de
// índice pesa mais que a semântica do nome da coluna: uma chave perfeita sem
// índice é pior que uma chave razoável indexada.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'
import { discoverKeys, type TableKeys } from '../../connectors/introspect.js'
import { discoverColumns } from '../../connectors/pools.js'
import { getConnector } from '../../connectors/registry.js'
import type { IncrementalPlan, PlanProposal, FieldDrift, SyncHealth, ReloadNeed } from '@datahub/shared'

export interface Field { key: string; sourceColumn: string; type: string }

// ── Reconhecimento de coluna por nome ────────────────────────────────────
// Duas listas por papel: EXATAS (o nome é o padrão, decide sozinho) e SOLTAS
// (o nome contém o radical, decide na falta de exata). Português e inglês
// porque as fontes são de épocas e fornecedores diferentes — ERP em
// português, RADIUS e AutoISP em inglês.
const CREATED_EXACT = [
  'created_at', 'createdat', 'created', 'create_date', 'creation_date',
  'data_cadastro', 'datacadastro', 'dt_cadastro', 'data_criacao', 'datacriacao',
  'dt_criacao', 'criado_em', 'criacao', 'cadastro', 'data_inclusao', 'dt_inclusao',
  'inserted_at', 'data_registro', 'dt_registro', 'data_abertura', 'dt_abertura',
]
const CREATED_LOOSE = /cria|cadastr|inclus|created|insert|abertura|emissao|emissão/i

const MODIFIED_EXACT = [
  'updated_at', 'updatedat', 'modified_at', 'modified', 'update_date', 'last_update',
  'data_alteracao', 'dataalteracao', 'dt_alteracao', 'data_atualizacao',
  'dt_atualizacao', 'alterado_em', 'atualizado_em', 'ultima_alteracao',
  'ultima_atualizacao', 'data_modificacao', 'dt_modificacao',
]
const MODIFIED_LOOSE = /atualiz|alterac|alteraç|alterad|modific|updated|last_?mod/i

const norm = (s: string) => s.toLowerCase().replace(/[\s-]/g, '_')

// Pontuação de um candidato: menor é melhor. Exata vence solta; entre iguais,
// vence a que é PRIMEIRA COLUNA de algum índice (a única que deixa o
// `order by` do keyset usar índice); depois, o nome mais curto — em tabela de
// ERP, `data_cadastro` costuma ser o carimbo real e
// `data_cadastro_complemento` o acessório.
function rank(field: Field, exact: string[], loose: RegExp, keys: TableKeys): number | null {
  const n = norm(field.sourceColumn)
  const i = exact.indexOf(n)
  const base = i >= 0 ? i : loose.test(n) ? exact.length + 50 : null
  if (base == null) return null
  const indexed = keys.leadingColumns.has(field.sourceColumn) ? 0 : 1000
  return base + indexed + Math.min(49, field.sourceColumn.length)
}

function pick(
  fields: Field[], exact: string[], loose: RegExp, keys: TableKeys, excludeExact: string[],
): Field | null {
  const candidates = fields
    .filter((f) => f.type === 'date')
    // Um nome que bate EXATO no papel oposto (`data_atualizacao` quando se
    // procura o "criado") não é candidato, por mais que o radical solto case.
    .filter((f) => !excludeExact.includes(norm(f.sourceColumn)))
    .map((f) => ({ f, score: rank(f, exact, loose, keys) }))
    .filter((c): c is { f: Field; score: number } => c.score != null)
    .sort((a, b) => a.score - b.score)
  return candidates[0]?.f ?? null
}

// ── Identidade da linha ──────────────────────────────────────────────────
// Ordem de preferência: PK > índice único de 1 coluna > índice único composto.
// Toda coluna da chave precisa estar publicada como campo do conjunto — uma
// identidade que referencia coluna não ingerida não existe no lake.
function pickIdentity(
  fields: Field[], keys: TableKeys,
): { dedupeKeys: string[]; source: string } | null {
  const byColumn = new Map(fields.map((f) => [f.sourceColumn, f.key]))
  const map = (cols: string[]): string[] | null => {
    const mapped = cols.map((c) => byColumn.get(c))
    return mapped.every((k): k is string => !!k) ? mapped : null
  }

  if (keys.primaryKey.length) {
    const mapped = map(keys.primaryKey)
    if (mapped) return { dedupeKeys: mapped, source: `chave primária (${keys.primaryKey.join(', ')})` }
  }
  for (const u of keys.uniques) {
    if (u.primary) continue // já tentado acima, e falhou por coluna não publicada
    const mapped = map(u.columns)
    if (mapped) return { dedupeKeys: mapped, source: `índice único "${u.name}" (${u.columns.join(', ')})` }
  }
  return null
}

// Última tentativa quando não há PK nem índice único legível (view, ou
// permissão que não alcança o catálogo): uma coluna numérica com cara de
// identificador. É palpite, e sai marcado como tal — por isso confiança baixa.
const ID_LIKE = /^(id|codigo|código|cod|seq|sequencia|sequência|.*_id|id_.*|.*_codigo)$/i
function guessIdentity(fields: Field[]): { dedupeKeys: string[]; source: string } | null {
  const c = fields
    .filter((f) => f.type === 'number' && ID_LIKE.test(norm(f.sourceColumn)))
    .sort((a, b) => a.sourceColumn.length - b.sourceColumn.length)[0]
  return c ? { dedupeKeys: [c.key], source: `palpite pelo nome da coluna "${c.sourceColumn}"` } : null
}

// ── Diagnóstico de um conjunto ───────────────────────────────────────────
// A DECISÃO é pura: recebe os campos publicados, o catálogo lido da origem e a
// configuração atual, e devolve o plano. Separada da leitura do banco de
// propósito — é a parte com regra de verdade (e a única testável sem Postgres
// nem fonte no ar; ver dev/autotuneSmoke.ts).
export type PlanBase = Omit<IncrementalPlan,
  'proposed' | 'confidence' | 'alreadyApplied' | 'reasons' | 'warnings' | 'blocker'>

export function decidePlan(base: PlanBase, fields: Field[], keys: TableKeys): IncrementalPlan {
  const current = base.current
  const reasons: string[] = []
  const warnings: string[] = []

  // ANTES de tudo: o conjunto consegue sequer sincronizar? Um campo apontando
  // para coluna que sumiu da fonte faz TODA execução morrer no SELECT — e
  // nenhuma regra de atualização conserta isso. Propor cadência de minutos
  // para um conjunto que falha 100% das vezes seria só ruído com cara de
  // diagnóstico. Este caso vem primeiro, e bloqueia.
  if (base.drift.missing.length) {
    const lista = base.drift.missing.map((m) => `"${m.sourceColumn}"`).join(', ')
    return {
      ...base, proposed: null, confidence: 'baixa', alreadyApplied: false, reasons, warnings,
      blocker:
        `${base.drift.missing.length} campo(s) apontam para coluna(s) que NÃO existem mais na fonte: ${lista}. ` +
        'Toda sincronização falha no SELECT («column ... does not exist») e o conjunto está parado desde então. ' +
        'Reconcilie os campos com a fonte antes de falar em cadência — nenhuma regra de atualização conserta isto.',
    }
  }
  if (base.drift.extra.length) {
    warnings.push(
      `A fonte ganhou ${base.drift.extra.length} coluna(s) que este conjunto não publica: ` +
      `${base.drift.extra.slice(0, 8).join(', ')}${base.drift.extra.length > 8 ? '…' : ''}. ` +
      'Não quebra nada — mas se alguma delas for a data de criação/edição, publicá-la abre a porta para o incremental.',
    )
  }
  // Falhando por OUTRO motivo (rede, permissão, tipo): a regra até pode ser
  // melhorada, mas trocar a cadência de um conjunto que erra toda vez só faz
  // ele errar mais vezes por dia. O aviso sobe junto com a proposta.
  if (base.health.failing) {
    warnings.push(
      `Este conjunto está FALHANDO: ${base.health.failuresSinceSuccess} execução(ões) com erro desde o último ` +
      `sucesso${base.health.lastSuccessAt ? ` (${new Date(base.health.lastSuccessAt).toLocaleString('pt-BR')})` : ' — nunca houve um'}. ` +
      `Último erro: ${(base.health.lastError ?? '').slice(0, 200)}. Resolva isto antes de aumentar a frequência.`,
    )
  }

  if (keys.error) {
    return {
      ...base, proposed: null, confidence: 'baixa', alreadyApplied: false,
      reasons: [], warnings: [],
      blocker: `Não foi possível ler o catálogo da fonte: ${keys.error}`,
    }
  }
  if (keys.isView) {
    warnings.push(
      'A origem é uma VIEW: não tem chave primária nem índice próprio. A identidade ' +
      'e o custo de cada lote dependem das tabelas por trás dela, que este diagnóstico não enxerga.',
    )
  }

  // 1) Identidade — decidida ANTES das chaves, porque a 2ª chave depende dela
  //    (constraint no banco: sem identidade, duas passadas duplicam a linha).
  const identity = pickIdentity(fields, keys) ?? (keys.isView || !keys.uniques.length ? guessIdentity(fields) : null)
  const identityIsGuess = !!identity && identity.source.startsWith('palpite')
  if (identity) {
    reasons.push(`Identidade da linha: ${identity.dedupeKeys.join(' + ')} — ${identity.source}.`)
    if (identityIsGuess) {
      warnings.push(
        `A identidade veio de PALPITE pelo nome, não de chave declarada no banco. ` +
        `Confira se "${identity.dedupeKeys.join(' + ')}" realmente não repete antes de aplicar.`,
      )
    }
  } else {
    warnings.push(
      'Sem identidade de linha: a tabela não tem chave primária nem índice único cujas colunas ' +
      'estejam publicadas neste conjunto. Sem identidade, o incremental só ACRESCENTA — uma linha ' +
      'editada passa a conviver com a versão antiga no lake.',
    )
  }

  // 2) Chaves incrementais.
  const created = pick(fields, CREATED_EXACT, CREATED_LOOSE, keys, MODIFIED_EXACT)
  const modified = pick(fields, MODIFIED_EXACT, MODIFIED_LOOSE, keys, CREATED_EXACT)

  // Sem nenhuma coluna de data: resta a chave numérica crescente, que pega
  // inserção e não pega edição. Vale a pena mesmo assim — é a diferença entre
  // recarregar a tabela inteira toda noite e ler só o que entrou.
  //
  // MAS a coluna precisa ser ÚNICA POR LINHA, e isso não se descobre pelo
  // nome. Uma passada keyset lê `where chave > cursor order by chave limit n`:
  // se o valor repete e o lote corta no meio de um grupo, o cursor avança para
  // esse valor e o `>` DESCARTA o resto do grupo. Não dá erro, não trava — só
  // some dado, em silêncio, para sempre.
  //
  // Foi o que aconteceu ao aceitar nome com cara de id: `id_agente` (primeira
  // coluna de uma PK composta `(id_agente, data_login)`, repete a cada login do
  // mesmo agente) e `cet_id` (chave estrangeira; a PK da tabela era outra).
  // Por isso a unicidade agora vem do CATÁLOGO — PK de coluna única ou índice
  // único de coluna única —, nunca do nome. Na dúvida, não propõe.
  const unicasPorLinha = new Set<string>([
    ...(keys.primaryKey.length === 1 ? [keys.primaryKey[0]] : []),
    ...keys.uniques.filter((u) => u.columns.length === 1).map((u) => u.columns[0]),
  ])
  let key1 = created
  let numericFallback = false
  if (!key1) {
    const f = fields.find((x) => x.type === 'number' && unicasPorLinha.has(x.sourceColumn))
    if (f) { key1 = f; numericFallback = true }
  }

  if (!key1) {
    return {
      ...base, proposed: null, confidence: 'baixa', alreadyApplied: false, reasons, warnings,
      blocker:
        'Nenhuma coluna serve de chave incremental. Não há campo de data com cara de "criado em", e ' +
        'nenhuma coluna numérica publicada é ÚNICA POR LINHA segundo o catálogo (chave primária de uma ' +
        'coluna só, ou índice único de uma coluna só). Coluna numérica que repete não serve: a leitura ' +
        'incremental avançaria o corte e descartaria o resto do grupo repetido, sem erro nenhum. ' +
        'Este conjunto continua em snapshot — se a tabela for grande, prefira cadência diária, ou publique ' +
        'uma coluna de data de criação, se ela existir na tabela.',
    }
  }

  const indexed = (f: Field) => keys.leadingColumns.has(f.sourceColumn)
  const key1Indexed = keys.isView || indexed(key1)
  const key2 = identity ? modified : null
  const key2Indexed = !key2 || keys.isView || indexed(key2)

  if (numericFallback) {
    reasons.push(
      `Chave incremental: ${key1.key} (identificador numérico crescente) — a tabela não tem coluna de data de criação.`,
    )
    warnings.push(
      'Com chave numérica, o incremental pega LINHAS NOVAS e não pega EDIÇÕES. ' +
      'Se esta tabela é editada depois de criada, o lake vai ficar desatualizado nessas linhas.',
    )
  } else {
    reasons.push(`Chave incremental: ${key1.key} (coluna "${key1.sourceColumn}", data de criação).`)
  }
  if (key2) {
    reasons.push(`2ª chave: ${key2.key} (coluna "${key2.sourceColumn}", data de edição) — é o que faz a edição voltar.`)
  } else if (modified && !identity) {
    warnings.push(
      `A tabela TEM coluna de edição ("${modified.sourceColumn}"), mas a 2ª chave exige identidade da linha ` +
      '— sem ela, a linha criada E editada na mesma janela entraria duplicada. Defina a identidade para aproveitá-la.',
    )
  } else if (!modified) {
    reasons.push('Sem coluna de edição na tabela: uma passada só, pela data de criação.')
  }

  // 3) Cobertura de índice — o que decide se cabe cadência de minutos.
  if (!key1Indexed) {
    warnings.push(
      `A coluna "${key1.sourceColumn}" NÃO é a primeira coluna de nenhum índice. Cada lote vai varrer a ` +
      'tabela inteira na fonte. Em cadência de minutos isso é varredura completa centenas de vezes por dia — ' +
      'peça um índice nessa coluna à equipe do banco, ou deixe este conjunto em cadência de hora em hora.',
    )
  }
  if (key2 && !key2Indexed) {
    warnings.push(
      `A 2ª chave "${key2.sourceColumn}" não tem índice próprio — mesma varredura completa, na segunda passada.`,
    )
  }

  // 4) Cadência recomendada. Minutos só quando dá para PROVAR que a leitura na
  //    fonte é barata — chave indexada, em tabela física. Numa view não dá:
  //    o custo real é o da consulta por trás dela, que este diagnóstico não
  //    enxerga, e uma view cara em cadência de minutos é exatamente o jeito de
  //    derrubar a produção achando que se está fazendo ingestão leve. Na
  //    dúvida, hora em hora — subir a cadência depois é barato, descobrir que
  //    ela derrubou o banco não é.
  const fullyIndexed = key1Indexed && key2Indexed && !keys.isView
  const cadence: PlanProposal['cadence'] = fullyIndexed ? 'schedule' : 'hourly'
  if (fullyIndexed) {
    reasons.push('Chaves indexadas: cabe cadência de minutos — cada sync lê só o que passou do watermark.')
  } else if (keys.isView) {
    reasons.push(
      'Por ser view, a recomendação fica em de hora em hora: o custo de cada leitura é o da consulta ' +
      'por trás dela. Se você sabe que é barata, dá para subir para minutos à mão depois.',
    )
  } else {
    reasons.push('Sem índice na chave, a recomendação cai para de hora em hora até o índice existir.')
  }

  // 5) Folga de reconferência: só faz sentido em chave de DATA, e só é segura
  //    com identidade (ela relê de propósito, e quem absorve a repetição é a
  //    compactação). Sem identidade, folga = duplicata garantida.
  //
  //    O que importa é haver ALGUMA chave temporal, não a 1ª ser temporal: o
  //    motor aplica a folga por chave e ignora as não-temporais (ver `lagged`
  //    em ingest.ts). Numa tabela sem coluna de criação — 1ª chave numérica, 2ª
  //    chave `updated_at` — a folga é a ÚNICA proteção contra uma edição com
  //    carimbo retroativo cair atrás do corte e sumir; amarrá-la à 1ª chave
  //    deixava justamente esse caso desprotegido.
  const temChaveDeData = !numericFallback || !!key2
  const lag = temChaveDeData && identity ? 10 : 0
  if (lag) {
    reasons.push(
      `Folga de reconferência: ${lag} min — edição que chega com carimbo atrasado (transação longa, ` +
      'relógio da fonte) não fica atrás do corte. A repetição é absorvida pela identidade.',
    )
  }

  const proposed: PlanProposal = {
    mode: 'incremental',
    incrementalKey: key1.key,
    incrementalKey2: key2?.key ?? null,
    dedupeKeys: identity?.dedupeKeys ?? [],
    watermarkLagMinutes: lag,
    cadence,
  }

  // 6) O que acontece NA PRIMEIRA carga depois de aplicar. São as duas coisas
  //    que assustam quem olha o painel no dia seguinte sem saber o que esperar.
  const big = (base.rowCount ?? 0) >= 1_000_000
  if (current.mode !== 'incremental') {
    warnings.push(
      'Trocar o modo zera o watermark: a PRIMEIRA carga incremental lê a tabela inteira uma vez' +
      (big ? ` (${base.rowCount!.toLocaleString('pt-BR')} linhas)` : '') +
      '. Depois dela, só o que passar do watermark. Aplique fora do horário de pico.',
    )
  } else if (!current.dedupeKeys.length && proposed.dedupeKeys.length) {
    warnings.push(
      'Na primeira sincronização com identidade definida o TOTAL DE LINHAS VAI CAIR. Isso é o conserto, ' +
      'não perda: as versões antigas de linhas editadas, que o incremental vinha acumulando sem nunca ' +
      'remover, são colapsadas na compactação. Não reverta achando que quebrou.',
    )
  }

  // Confiança: alta = identidade declarada no banco + chave de data indexada.
  const confidence: IncrementalPlan['confidence'] =
    identity && !identityIsGuess && !numericFallback && fullyIndexed ? 'alta'
      : !identity || identityIsGuess || !fullyIndexed ? 'baixa'
        : 'media'

  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  const alreadyApplied = current.mode === proposed.mode
    && current.incrementalKey === proposed.incrementalKey
    && current.incrementalKey2 === proposed.incrementalKey2
    && sameSet(current.dedupeKeys, proposed.dedupeKeys)
    && current.watermarkLagMinutes === proposed.watermarkLagMinutes

  return { ...base, proposed, confidence, alreadyApplied, reasons, warnings, blocker: null }
}

// Compara os campos PUBLICADOS com as colunas que a fonte tem HOJE.
//
// Existe porque o mapeamento campo→coluna é gravado na publicação e nunca mais
// conferido: se alguém renomeia ou remove a coluna na origem, o conjunto passa
// a falhar em TODA execução (o SELECT da ingestão inclui a coluna que sumiu) e
// nada no sistema diz o porquê — o erro fica só no histórico de execuções,
// dentro da tela do conjunto, onde ninguém procura.
async function fieldDrift(
  ds: { connection_id: unknown; schema_name: unknown; object_name: unknown }, fields: Field[],
): Promise<FieldDrift> {
  try {
    const cols = await discoverColumns(String(ds.connection_id), String(ds.schema_name), String(ds.object_name))
    const existentes = new Set(cols.map((c) => c.name))
    const publicadas = new Set(fields.map((f) => f.sourceColumn))
    return {
      missing: fields.filter((f) => !existentes.has(f.sourceColumn))
        .map((f) => ({ key: f.key, sourceColumn: f.sourceColumn })),
      extra: cols.map((c) => c.name).filter((n) => !publicadas.has(n)),
      checked: true,
    }
  } catch {
    // Fonte fora do ar ou sem permissão no catálogo: não dá para afirmar nada.
    // Devolver "nada faltando" seria mentir; `checked: false` diz que não sabe.
    return { missing: [], extra: [], checked: false }
  }
}

// Como foram as últimas execuções. É o que responde, na tela, "por que esta
// fonte não atualiza?" — muitas vezes a resposta não é a cadência, é que ela
// vem falhando há dias e ninguém viu.
async function syncHealth(datasetId: string): Promise<SyncHealth> {
  const runs = (await db.query(
    `select status, error, started_at from sync_runs
      where dataset_id = $1 and status <> 'running'
      order by started_at desc limit 50`,
    [datasetId],
  )).rows
  const ultimo = runs[0]
  const sucesso = runs.find((r) => String(r.status) === 'done')
  // Conta os erros ATÉ o último sucesso — "falha há 3 dias" é mais útil que
  // "12 erros no total", que não diz se já voltou ao normal.
  let falhas = 0
  for (const r of runs) {
    if (String(r.status) === 'done') break
    if (String(r.status) === 'error') falhas++
  }
  return {
    lastSuccessAt: sucesso ? new Date(sucesso.started_at as string).toISOString() : null,
    lastRunAt: ultimo ? new Date(ultimo.started_at as string).toISOString() : null,
    lastError: (runs.find((r) => r.error)?.error as string | null) ?? null,
    failuresSinceSuccess: falhas,
    failing: !!ultimo && String(ultimo.status) === 'error',
  }
}

// Precisa de recarga completa por causa do defeito de fuso?
//
// A resposta mais valiosa aqui é o NÃO: recarregar um conjunto grande à toa
// custa horas de fila e um pico de disco, e a maioria dos conjuntos não
// precisa. Três motivos para não precisar, e todos são certeza, não palpite:
//
//   • fonte MySQL/MariaDB — nunca foi afetada (o driver já devolvia texto);
//   • modo snapshot — relê a tabela inteira a cada execução, então a primeira
//     execução depois do deploy já regravou tudo certo, sozinha;
//   • conjunto sem nenhuma coluna de data — não há horário para estar errado.
//
// Sobra o que de fato precisa: fonte Postgres, em incremental, com coluna de
// data. Nesses, o que está gravado continua 3h adiantado, e onde a 2ª chave é
// temporal ainda faltam as linhas que o corte no futuro pulou.
async function reloadNeed(
  ds: { id: unknown; connection_id: unknown; sync_mode: unknown }, fields: Field[],
): Promise<ReloadNeed> {
  // Tamanho e ritmo saem do histórico de execuções — é o que permite dizer
  // "este leva 40 minutos" em vez de "pode demorar".
  const stat = (await db.query(
    `select rows, bytes, started_at, finished_at from sync_runs
      where dataset_id = $1 and status = 'done' and finished_at is not null and rows > 0
      order by rows desc limit 1`,
    [String(ds.id)],
  )).rows[0]
  const lakeBytes = (await db.query(
    `select bytes from sync_runs where dataset_id = $1 and status = 'done'
      order by started_at desc limit 1`,
    [String(ds.id)],
  )).rows[0]?.bytes ?? null

  const kind = getConnector(String(ds.connection_id))?.kind
  const temData = fields.some((f) => f.type === 'date')
  const modo = String(ds.sync_mode)

  let needed = false
  let reason: string
  if (kind !== 'postgres') {
    reason = `Fonte ${kind ?? 'desconhecida'}: nunca foi afetada pelo defeito de fuso.`
  } else if (!temData) {
    reason = 'Nenhuma coluna de data neste conjunto — não há horário para corrigir.'
  } else if (modo !== 'incremental') {
    reason = 'Está em snapshot: relê a tabela inteira a cada execução, então já se corrigiu sozinho.'
  } else {
    needed = true
    reason = 'Fonte Postgres em incremental: os horários já gravados seguem 3h adiantados, ' +
      'e o corte no futuro pode ter pulado linhas. Só uma releitura completa conserta.'
  }

  // Ritmo da melhor execução conhecida, aplicado ao total de linhas.
  let estimatedMinutes: number | null = null
  if (needed && stat) {
    const ms = new Date(stat.finished_at as string).getTime() - new Date(stat.started_at as string).getTime()
    const linhas = Number(stat.rows)
    if (ms > 0 && linhas > 0) {
      const total = Number((await db.query(`select row_count from datasets where id = $1`, [String(ds.id)]))
        .rows[0]?.row_count ?? linhas)
      estimatedMinutes = Math.max(1, Math.round((total / linhas) * ms / 60_000))
    }
  }
  return { needed, reason, lakeBytes: lakeBytes == null ? null : Number(lakeBytes), estimatedMinutes }
}

// Lê o que a decisão precisa (catálogo do hub + catálogo da origem) e decide.
export async function planFor(datasetId: string): Promise<IncrementalPlan> {
  const ds = (await db.query(
    `select id, slug, name, connection_id, schema_name, object_name, row_count,
            sync_mode, incremental_key, incremental_key_2, dedupe_keys,
            sync_cadence, schedule_id, watermark_lag_minutes
       from datasets where id = $1 and kind <> 'derived'`,
    [datasetId],
  )).rows[0]
  if (!ds) throw new Error('Conjunto não encontrado (ou é um conjunto calculado, que não ingere de fonte).')

  const fields: Field[] = (await db.query(
    `select key, source_column, type from dataset_fields where dataset_id = $1 order by sort_order`,
    [datasetId],
  )).rows.map((r) => ({ key: String(r.key), sourceColumn: String(r.source_column), type: String(r.type) }))

  const keys = await discoverKeys(String(ds.connection_id), String(ds.schema_name), String(ds.object_name))
  const drift = await fieldDrift(ds, fields)
  const health = await syncHealth(String(ds.id))
  const reload = await reloadNeed(ds, fields)

  return decidePlan({
    datasetId: String(ds.id), slug: String(ds.slug), name: String(ds.name),
    connectionId: String(ds.connection_id), schema: String(ds.schema_name),
    table: String(ds.object_name), rowCount: ds.row_count == null ? null : Number(ds.row_count),
    drift, health, reload,
    current: {
      mode: String(ds.sync_mode) as IncrementalPlan['current']['mode'],
      incrementalKey: (ds.incremental_key as string | null) ?? null,
      incrementalKey2: (ds.incremental_key_2 as string | null) ?? null,
      dedupeKeys: ((ds.dedupe_keys as string[] | null) ?? []),
      cadence: String(ds.sync_cadence) as IncrementalPlan['current']['cadence'],
      watermarkLagMinutes: Number(ds.watermark_lag_minutes ?? 0),
    },
  }, fields, keys)
}

// Diagnostica TODOS os conjuntos de fonte do tenant. A introspecção é uma
// consulta de catálogo por conjunto — leve, mas serializada de propósito: o
// contrato do hub é nunca abrir várias conexões de uma vez contra a produção.
export async function planAll(tenantSlug: string): Promise<IncrementalPlan[]> {
  const rows = (await db.query(
    `select d.id from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind <> 'derived'
      order by d.name`,
    [tenantSlug],
  )).rows

  const plans: IncrementalPlan[] = []
  for (const r of rows) {
    try {
      plans.push(await planFor(String(r.id)))
    } catch (e) {
      console.warn(`[autotune] falha ao analisar ${r.id}: ${(e as Error).message}`)
    }
  }
  return plans
}
