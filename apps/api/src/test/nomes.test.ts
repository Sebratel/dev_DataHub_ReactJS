// ─────────────────────────────────────────────────────────────────────────
// Padrão de nomes dos conjuntos (19/11/2026): <camada>_<área>_<assunto>.
//
// Conjunto novo nasce no padrão. Renomear um antigo não pode quebrar quem usa
// o nome velho: link, token da API pública, SQL de calculado e filtro de aba.
// O nome antigo vira apelido — e nenhum conjunto novo pode pegá-lo.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  as, anon, db, shutdown, seedDataset, connectTestSource, fonteDb, publishSource, syncAndWait, waitFor, lakeCount,
} from './harness.js'
import {
  snake, nomePadrao, segueOPadrao, areaDaFonte, comSufixo, nomeLivre, nomesOcupados,
} from '../modules/catalog/naming.js'
import { referencedSlugs } from '../modules/transform/derive.js'
import { LAKE_ROOT } from '../core/lake.js'

let conn = ''
let legadoId = ''
const LEGADO = 'teste-comite-legado'
const NOVO = 'bronze_legado_clientes'

before(async () => {
  conn = await connectTestSource()
  legadoId = await seedDataset({
    slug: LEGADO,
    fields: [{ key: 'id', type: 'number' }, { key: 'cliente' }],
    rowsSql: `select * from (values (1, 'ana'), (2, 'bia'), (3, 'caio'), (4, 'davi')) t(id, cliente)`,
  })
})
after(shutdown)

const tenantId = async () => String((await db.query(`select id from tenants where slug = 'sebratel'`)).rows[0].id)

describe('Padrão de nomes: regra', () => {
  it('monta <camada>_<área>_<assunto> em minúsculas, com sublinhado', () => {
    assert.equal(snake('Contratos Ativos (2024)'), 'contratos_ativos_2024')
    assert.equal(snake('Títulos à vencer'), 'titulos_a_vencer')
    assert.equal(nomePadrao({ camada: 'bronze', area: 'voalle', nome: 'contracts' }), 'bronze_voalle_contracts')
    assert.equal(nomePadrao({ camada: 'bronze', area: 'voalle', nome: 'voalle-contracts' }), 'bronze_voalle_contracts', 'área repetida')
    assert.equal(nomePadrao({ camada: 'prata', nome: 'Cancelamentos mensal' }), 'prata_cancelamentos_mensal')
    assert.equal(nomePadrao({ camada: 'prata', nome: 'Ouro financeiro títulos' }), 'ouro_financeiro_titulos', 'camada dada no nome vence')
    assert.equal(areaDaFonte('elleven'), 'voalle')
    assert.equal(areaDaFonte('maria', 'DB_Massives'), 'massives')
    assert.equal(areaDaFonte('maria', 'API_WebDeveloper'), 'api_webdeveloper')
    assert.ok(segueOPadrao('ouro_financeiro_titulos_abertos_diario'))
    for (const fora of ['contratos-ativos', 'Bronze_x', 'bronze', 'bronze_', 'bronze__x', 'gold_x', 'bronze_x-y']) {
      assert.ok(!segueOPadrao(fora), fora)
    }
    assert.equal(comSufixo('prata_x', 2), 'prata_x_2')
    assert.equal(comSufixo('db-matrix', 2), 'db-matrix-2')
    assert.equal(nomeLivre('prata_x', new Set(['prata_x', 'prata_x_2'])), 'prata_x_3')
    assert.equal(nomeLivre('a-b', new Set(['a_b'])), 'a-b-2', 'o apelido com sublinhado também ocupa')
  })

  it('publicar e criar calculado já nascem no padrão', async () => {
    await fonteDb.query(`create table fonte.planos as select g as id, 'plano ' || g as nome from generate_series(1, 6) g`)
    const fonte = await publishSource(conn, 'planos', { syncMode: 'snapshot' })
    assert.equal(fonte.slug, 'bronze_teste_comite_fonte_planos')

    const calc = await as('editor').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE Planos ativos', sql: `select id from ${LEGADO.replace(/-/g, '_')}`,
    })
    assert.equal(calc.status, 201, JSON.stringify(calc.body))
    assert.equal(calc.body.slug, 'prata_teste_comite_planos_ativos')
  })
})

describe('Padrão de nomes: renomear sem quebrar quem usa o nome antigo', () => {
  let calcId = ''
  let token = ''
  let abaId = ''

  before(async () => {
    // Quem já usa o nome antigo: um calculado (pelo apelido com sublinhado),
    // um token da API pública e um filtro de aba de painel.
    const calc = await as('admin').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE soma legado', sql: `select count(*) as n from ${LEGADO.replace(/-/g, '_')}`,
    })
    assert.equal(calc.status, 201, JSON.stringify(calc.body))
    calcId = String(calc.body.id)
    await waitFor(async () => Number((await db.query('select row_count from datasets where id = $1', [calcId])).rows[0]?.row_count) === 1)

    const t = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE nomes', datasetSlugs: [LEGADO] })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    token = String(t.body.token)

    const tenant = await tenantId()
    const dash = (await db.query(
      `insert into dashboards (tenant_id, name, description, owner_email, visibility)
       values ($1, 'TESTE-COMITE painel nomes', '', 'teste.admin@sebratel.com.br', 'private') returning id`, [tenant],
    )).rows[0]
    abaId = String((await db.query(
      `insert into dashboard_tabs (dashboard_id, label, sort_order, config) values ($1, 'Geral', 0, $2::jsonb) returning id`,
      [dash.id, JSON.stringify({ filters: [{ field: 'cliente', label: 'Cliente', kind: 'multiselect', datasetSlug: LEGADO }] })],
    )).rows[0].id)
  })

  it('a tela lista o conjunto fora do padrão com uma sugestão', async () => {
    const r = await as('admin').get('/api/v1/datasets/naming')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const it = r.body.items.find((x: { id: string }) => x.id === legadoId)
    assert.equal(it.conforme, false)
    assert.equal(it.sugestao, 'bronze_teste_comite_legado')
    assert.equal((await as('editor').get('/api/v1/datasets/naming')).status, 403)
  })

  it('recusa nome fora do padrão, nome de outro conjunto e quem não é admin', async () => {
    const ad = as('admin')
    assert.equal((await ad.post(`/api/v1/datasets/${legadoId}/rename`, { slug: 'Clientes Legado' })).status, 400)
    assert.equal((await ad.post(`/api/v1/datasets/${legadoId}/rename`, { slug: 'legado_clientes' })).status, 400, 'sem camada')
    assert.equal((await ad.post(`/api/v1/datasets/${legadoId}/rename`, { slug: 'bronze_teste_comite_fonte_planos' })).status, 409)
    assert.equal((await as('editor').post(`/api/v1/datasets/${legadoId}/rename`, { slug: NOVO })).status, 403)
  })

  it('renomeia: o nome antigo continua valendo na URL, no token, no SQL e no filtro da aba', async () => {
    const r = await as('admin').post(`/api/v1/datasets/${legadoId}/rename`, { slug: NOVO })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.previous, LEGADO)

    // A pasta do lake foi junto.
    assert.equal(await lakeCount(NOVO), 4)
    assert.ok(!existsSync(join(LAKE_ROOT, 'sebratel', LEGADO)), 'a pasta antiga ficou para trás')

    // Link salvo com o nome antigo abre o conjunto pelo nome novo.
    const det = await as('viewer').get(`/api/v1/datasets/${LEGADO}`)
    assert.equal(det.status, 200, JSON.stringify(det.body))
    assert.equal(det.body.dataset.slug, NOVO)
    const q = await as('viewer').post(`/api/v1/datasets/${LEGADO}/query`, { select: [{ agg: 'count', as: 'n' }] })
    assert.equal(Number(q.body.rows?.[0]?.n), 4, JSON.stringify(q.body))

    // Integração com token: segue funcionando pelos dois nomes.
    assert.equal((await anon.get(`/api/public/v1/datasets/${LEGADO}/rows?limit=1`, token)).status, 200)
    assert.equal((await anon.get(`/api/public/v1/datasets/${NOVO}/rows?limit=1`, token)).status, 200)

    // O calculado que cita o nome antigo continua dependente e recalcula.
    const sql = String((await db.query('select transform_sql from datasets where id = $1', [calcId])).rows[0].transform_sql)
    assert.deepEqual(referencedSlugs(sql, [NOVO]), [NOVO], 'a dependência pelo nome antigo se perdeu')
    await syncAndWait(calcId) // lança se o recálculo falhar
    assert.equal(Number((await db.query('select row_count from datasets where id = $1', [calcId])).rows[0].row_count), 1)

    // Filtro da aba aponta para o nome novo.
    const cfg = (await db.query('select config from dashboard_tabs where id = $1', [abaId])).rows[0].config
    const filtros = (typeof cfg === 'string' ? JSON.parse(cfg) : cfg).filters
    assert.equal(filtros[0].datasetSlug, NOVO)

    // A tela mostra o apelido, e o nome antigo não volta a ficar livre.
    const lista = (await as('admin').get('/api/v1/datasets/naming')).body.items
    const item = lista.find((x: { id: string }) => x.id === legadoId)
    assert.equal(item.conforme, true)
    assert.deepEqual(item.apelidos, [LEGADO])
    assert.equal(nomeLivre(LEGADO, await nomesOcupados(db, await tenantId())), `${LEGADO}-2`)
  })

  it('oficial só o master renomeia', async () => {
    await db.query('update datasets set official = true where id = $1', [legadoId])
    try {
      assert.equal((await as('admin').post(`/api/v1/datasets/${legadoId}/rename`, { slug: 'bronze_legado_clientes_v2' })).status, 403)
      const m = await as('master').post(`/api/v1/datasets/${legadoId}/rename`, { slug: 'bronze_legado_clientes_v2' })
      assert.equal(m.status, 200, JSON.stringify(m.body))
      // Os dois nomes anteriores seguem respondendo.
      for (const antigo of [LEGADO, NOVO]) {
        const d = await as('viewer').get(`/api/v1/datasets/${antigo}`)
        assert.equal(d.body.dataset?.slug, 'bronze_legado_clientes_v2', antigo)
      }
    } finally {
      await db.query('update datasets set official = false where id = $1', [legadoId])
    }
  })
})
