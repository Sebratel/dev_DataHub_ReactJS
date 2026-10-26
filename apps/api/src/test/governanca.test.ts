// ─────────────────────────────────────────────────────────────────────────
// Testes FUNCIONAIS (§10.2), de DISPONIBILIDADE & GOVERNANÇA (§10.5) e de
// MONITORAMENTO (§10.6) do plano do comitê — os que dá para afirmar só com a
// API. Os marcados [H]/[T] que dependem de infraestrutura (reinício, banco
// fora, restauração) e os que medem tela ficam no roteiro manual.
//
// Mesma convenção de seguranca.test.ts: ID do documento no nome; fraqueza
// ainda aberta = `todo` com o ID dela.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, anon, seedDataset, shutdown, db, waitFor, baseUrl, USERS } from './harness.js'

let abertoId = ''


before(async () => {
  abertoId = await seedDataset({
    slug: 'teste-comite-aberto',
    objectName: 'tb_fisica_contratos_v2',
    fields: [
      { key: 'id', type: 'number' }, { key: 'cliente' }, { key: 'cpf', sensitive: true }, { key: 'valor', type: 'number' },
    ],
    rowsSql: `select * from (values (1, 'ana', '111.111.111-11', 100.0), (2, 'bia', '222.222.222-22', 250.0),
      (3, 'caio', '333.333.333-33', 50.0)) t(id, cliente, cpf, valor)`,
  })
  await seedDataset({
    slug: 'teste-comite-privado',
    visibility: 'private',
    owner: 'editor2',
    fields: [{ key: 'id', type: 'number' }, { key: 'nome' }],
    rowsSql: `select * from (values (1, 'x'), (2, 'y')) t(id, nome)`,
  })
  // viewer2 lê o privado, mas SEM permissão de exportar.
  const g = await as('editor2').post('/api/v1/admin/datasets/teste-comite-privado/grants', { email: USERS.viewer2, canExport: false })
  assert.equal(g.status, 201)
})

after(shutdown)

async function auditDe(email: string, action: string): Promise<Array<{ action: string; detail: any }>> {
  const r = await as('admin').get(`/api/v1/admin/audit?user=${encodeURIComponent(email)}&action=${encodeURIComponent(action)}&limit=300`)
  assert.equal(r.status, 200)
  return (r.body.events ?? r.body.logs ?? r.body.rows ?? r.body) as Array<{ action: string; detail: any }>
}

// ── Funcionais ─────────────────────────────────────────────────────────────
describe('T-FUN-02..05 catálogo, explorador, exportação e painel', () => {
  it('T-FUN-02 o catálogo do viewer não mostra o nome físico da tabela', async () => {
    const lista = await as('viewer').get('/api/v1/datasets')
    assert.equal(lista.status, 200)
    assert.ok(!JSON.stringify(lista.body).includes('tb_fisica_contratos_v2'), 'lista vaza o objeto físico')
    const det = await as('viewer').get('/api/v1/datasets/teste-comite-aberto')
    assert.equal(det.status, 200)
    assert.ok(!JSON.stringify(det.body).includes('tb_fisica_contratos_v2'), 'detalhe vaza o objeto físico')
  })

  it('T-FUN-03 visão salva reabre igual', async () => {
    const v = as('viewer')
    const definicao = { select: ['cliente', 'valor'], filters: [{ field: 'valor', op: '>', value: 60 }] }
    const c = await v.post(`/api/v1/datasets/${abertoId}/views`, { name: 'TESTE-COMITE visão', definition: definicao })
    assert.equal(c.status, 201)
    const l = await v.get(`/api/v1/datasets/${abertoId}/views`)
    const salva = (l.body.views ?? l.body).find((x: { name: string }) => x.name === 'TESTE-COMITE visão')
    assert.deepEqual(salva.definition, definicao)
    // E a consulta da visão dá o total coerente com o filtro.
    const q = await v.post('/api/v1/datasets/teste-comite-aberto/query', definicao)
    assert.equal(q.body.rows.length, 2)
  })

  it('T-FUN-04 exportar CSV (conjunto aberto e SEM dono): linhas = total, sensível mascarado', async () => {
    const r = await as('viewer').post('/api/v1/datasets/teste-comite-aberto/export?format=csv', { select: ['cliente', 'cpf'] })
    assert.equal(r.status, 200)
    const linhas = String(r.body).trim().split(/\r?\n/)
    assert.equal(linhas.length, 1 + 3, String(r.body))
    assert.ok(!String(r.body).includes('111.111.111-11'))
  })

  it('T-FUN-04 sem permissão de exportar: bloqueado', async () => {
    const pode = await as('viewer2').post('/api/v1/datasets/teste-comite-privado/query', {})
    assert.equal(pode.status, 200, 'viewer2 lê o conjunto')
    const r = await as('viewer2').post('/api/v1/datasets/teste-comite-privado/export?format=csv', {})
    assert.equal(r.status, 403)
    const t = await as('viewer2').post('/api/v1/datasets/teste-comite-privado/export/ticket?format=csv', {})
    assert.equal(t.status, 403, 'o caminho do navegador (ticket) também bloqueia')
  })

  it('T-FUN-05 painel compartilhado com o time (ver): membro vê e não edita', async () => {
    const team = await as('admin').post('/api/v1/admin/teams', { name: 'TESTE-COMITE time' })
    assert.equal(team.status, 201)
    const teamId = team.body.id ?? team.body.team?.id
    assert.equal((await as('admin').post(`/api/v1/admin/teams/${teamId}/members`, { email: USERS.editor2 })).status < 300, true)

    const dono = as('editor')
    const d = await dono.post('/api/v1/dashboards', { name: 'TESTE-COMITE painel do time' })
    assert.equal(d.status, 201)
    assert.equal((await dono.patch(`/api/v1/dashboards/${d.body.id}`, { visibility: 'private' })).status, 200)
    assert.equal((await dono.post(`/api/v1/dashboards/${d.body.id}/shares`, { teamId, level: 'view' })).status, 201)

    const membro = as('editor2')
    assert.equal((await membro.get(`/api/v1/dashboards/${d.body.id}`)).status, 200, 'membro do time vê')
    assert.equal((await membro.patch(`/api/v1/dashboards/${d.body.id}`, { name: 'invadido' })).status, 403, 'membro não edita')
    assert.equal((await as('viewer').get(`/api/v1/dashboards/${d.body.id}`)).status >= 400, true, 'quem não é do time não vê')
  })
})

describe('T-FUN-10 conjunto calculado', () => {
  it('T-FUN-10 editor cria um calculado; ele materializa e entra no catálogo', async () => {
    const r = await as('editor').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE calculado', sql: 'select cliente, valor * 2 as dobro from teste_comite_aberto',
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const pronto = await waitFor(async () => {
      const row = (await db.query('select row_count, kind from datasets where id = $1', [r.body.id])).rows[0]
      return row && Number(row.row_count) === 3 ? row : null
    })
    assert.ok(pronto, 'materialização não terminou')
    assert.equal(pronto!.kind, 'derived')
    const q = await as('editor').post(`/api/v1/datasets/${r.body.slug}/query`, { select: ['dobro'] })
    assert.equal(q.status, 200)
    assert.deepEqual(q.body.rows.map((x: { dobro: number }) => Number(x.dobro)).sort((a: number, b: number) => a - b), [100, 200, 500])
  })
})

// ── Governança ─────────────────────────────────────────────────────────────
describe('T-DSP-01..10 governança do conteúdo', () => {
  let calcId = ''

  before(async () => {
    const r = await as('editor').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE governança', sql: 'select id, cliente, valor from teste_comite_aberto',
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    calcId = r.body.id
    await waitFor(async () => Number((await db.query('select row_count from datasets where id = $1', [calcId])).rows[0]?.row_count) === 3)
  })

  it('T-DSP-01 o viewer não cria painel, métrica, calculado, token nem upstream', async () => {
    const v = as('viewer')
    assert.equal((await v.post('/api/v1/dashboards', { name: 'x' })).status, 403)
    assert.equal((await v.post('/api/v1/metrics', { datasetId: abertoId, name: 'x', agg: 'sum', fieldKey: 'valor' })).status, 403)
    assert.equal((await v.post('/api/v1/datasets/derived', { name: 'x', sql: 'select 1 from teste_comite_aberto' })).status, 403)
    assert.equal((await v.post('/api/v1/credentials', { name: 'x' })).status, 403)
    assert.equal((await v.post('/api/v1/gateway/upstreams', { slug: 'xyz', name: 'x', baseUrl: 'http://127.0.0.1:9' })).status, 403)
  })

  it('T-DSP-01 o viewer cria notebook (matriz §6.2: qualquer usuário)', async () => {
    const r = await as('viewer').post('/api/v1/notebooks', { name: 'TESTE-COMITE notebook' })
    assert.ok(r.status === 201 || r.status === 200, `status ${r.status}`)
  })

  it('T-DSP-03 painel recém-criado (rascunho) não aparece para os outros', {
    todo: 'DSP-05: painel nasce visível para todo o tenant.',
  }, async () => {
    const d = await as('editor').post('/api/v1/dashboards', { name: 'TESTE-COMITE-GOV rascunho' })
    const lista = await as('viewer').get('/api/v1/dashboards')
    assert.ok(!JSON.stringify(lista.body).includes(String(d.body.id)))
  })

  it('T-DSP-05 calculado OFICIAL não muda de SQL sem aprovação', {
    todo: 'DSP-03: o dono muda o SQL de um oficial, o selo continua e o SQL anterior se perde.',
  }, async () => {
    assert.equal((await as('admin').patch(`/api/v1/datasets/${calcId}`, { official: true })).status, 200)
    const r = await as('editor').patch(`/api/v1/datasets/derived/${calcId}`, { sql: 'select id from teste_comite_aberto' })
    assert.ok(r.status >= 400, `o dono reescreveu o oficial: ${r.status}`)
  })

  it('T-DSP-06 o dono arquiva ou exclui o próprio calculado sem dependentes', {
    todo: 'DSP-07: exclusão de conjunto é só de admin; o editor cria e não consegue limpar.',
  }, async () => {
    const r = await as('editor').post('/api/v1/datasets/derived', { name: 'TESTE-COMITE descartável', sql: 'select 1 as um from teste_comite_aberto' })
    const del = await as('editor').del(`/api/v1/datasets/${r.body.id}`)
    assert.ok(del.status < 300, `status ${del.status}`)
  })

  // `skip`, e não `todo`: o defeito É uma rejeição não tratada, e o executor de
  // testes derruba o arquivo inteiro quando ela acontece. Vira `it` normal no
  // dia em que as rotas assíncronas tratarem o erro (DSP-18).
  it('T-DSP-10 endereço inválido de painel responde em segundos', {
    skip: 'DSP-18 (confirmado à mão): id inválido gera rejeição não tratada e a requisição fica pendurada até o timeout do nginx.',
  }, async () => {
    const r = await fetch(`${baseUrl}/api/v1/dashboards/teste-invalido`, {
      headers: { Authorization: `Bearer ${as('viewer').token}` }, signal: AbortSignal.timeout(5_000),
    }).catch((e: Error) => e)
    assert.ok(!(r instanceof Error), 'sem resposta em 5 s')
    assert.ok((r as Response).status >= 400)
  })

  it('T-DSP-08 excluir conjunto com dependentes lista os dependentes e bloqueia', {
    todo: 'DSP-01: exclusão definitiva e em cascata — a métrica some junto, sem aviso nem lixeira.',
  }, async () => {
    // Calculado próprio (C1): o do T-DSP-05 pode ter tido o SQL reescrito.
    const c1 = await as('editor').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE C1', sql: 'select id, valor from teste_comite_aberto',
    })
    assert.equal(c1.status, 201, JSON.stringify(c1.body))
    await waitFor(async () => Number((await db.query('select row_count from datasets where id = $1', [c1.body.id])).rows[0]?.row_count) === 3)
    const m = await as('editor').post('/api/v1/metrics', { datasetId: c1.body.id, name: 'TESTE-COMITE M1', agg: 'sum', fieldKey: 'valor' })
    assert.equal(m.status, 201, JSON.stringify(m.body))
    const del = await as('admin').del(`/api/v1/datasets/${c1.body.id}`)
    assert.equal(del.status, 409, 'deveria recusar e listar a métrica dependente')
  })
})

// ── Monitoramento ──────────────────────────────────────────────────────────
describe('T-MON-02..05 monitoramento', () => {
  it('T-MON-03 exportação fica registrada com formato e número de linhas', async () => {
    await as('viewer').post('/api/v1/datasets/teste-comite-aberto/export?format=csv', { select: ['cliente'] })
    const ev = await waitFor(async () => (await auditDe(USERS.viewer, 'datasets.export')).find((e) => e.detail?.format === 'csv'))
    assert.ok(ev, 'nenhum "datasets.export" do viewer na auditoria')
    assert.equal(Number(ev!.detail.rows), 3)
  })

  it('T-MON-02 leitura de conjunto e execução de notebook ficam registradas', {
    todo: 'MON-01: consulta, abertura de painel, notebook e insight não deixam registro.',
  }, async () => {
    await as('viewer').post('/api/v1/datasets/teste-comite-aberto/query', {})
    await as('viewer').post('/api/v1/notebooks/run', { sql: 'select 1 as x from teste_comite_aberto' })
    const todos = await auditDe(USERS.viewer, '')
    assert.ok(todos.some((e) => /query|read|consult/.test(e.action)), 'consulta não registrada')
    assert.ok(todos.some((e) => /notebook.*run|notebooks\.run/.test(e.action)), 'notebook não registrado')
  })

  it('T-MON-04 mudar visibilidade e remover convidado ficam registrados', {
    todo: 'MON-05: só "Compartilhou dashboard" é auditado — visibilidade e remoção de convite, não.',
  }, async () => {
    const e = as('editor')
    const d = await e.post('/api/v1/dashboards', { name: 'TESTE-COMITE visibilidade' })
    await e.patch(`/api/v1/dashboards/${d.body.id}`, { visibility: 'private' })
    await e.post(`/api/v1/dashboards/${d.body.id}/shares`, { email: USERS.viewer, level: 'view' })
    const grants = (await e.get(`/api/v1/dashboards/${d.body.id}/shares`)).body.grants
    await e.del(`/api/v1/dashboards/${d.body.id}/shares/${grants[0].id}`)
    const ev = (await auditDe(USERS.editor, 'dashboards')).map((x) => x.action)
    assert.ok(ev.some((a) => /visib/.test(a)), `sem registro de visibilidade: ${ev}`)
    assert.ok(ev.some((a) => /unshare|share\.remove|revoke/.test(a)), `sem registro de remoção: ${ev}`)
  })

  it('T-MON-05 uso do token atualiza o "último uso"', async () => {
    const t = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE uso', datasetSlugs: ['teste-comite-aberto'] })
    assert.equal((await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows?limit=1', t.body.token)).status, 200)
    const usado = await waitFor(async () =>
      (await db.query('select last_used_at from api_credentials where id = $1', [t.body.id])).rows[0]?.last_used_at)
    assert.ok(usado, 'last_used_at não foi atualizado')
  })

  it('T-MON-05 a recusa por cota (429) fica ligada ao token', {
    todo: 'MON-07: a linha do 429 na telemetria sai sem o token que a causou.',
  }, async () => {
    const t = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE 429', datasetSlugs: ['teste-comite-aberto'] })
    await as('admin').put(`/api/v1/gateway/credentials/${t.body.id}/policy`, { quotaPerDay: 1 })
    await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows?limit=1', t.body.token)
    assert.equal((await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows?limit=1', t.body.token)).status, 429)
    const linha = await waitFor(async () =>
      (await db.query(`select credential_id from api_call_metrics where status = 429 order by 1 desc limit 1`)).rows[0], 5_000)
    assert.ok(linha, 'nenhuma linha de 429 na telemetria')
    assert.equal(String(linha!.credential_id), String(t.body.id))
  })
})
