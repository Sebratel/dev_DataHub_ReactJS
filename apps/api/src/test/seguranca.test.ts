// ─────────────────────────────────────────────────────────────────────────
// Testes de SEGURANÇA do plano do comitê (DATAHUB v0.1, §10.3), mais os
// funcionais que tocam acesso (T-FUN-01 login e papéis, T-FUN-12 tokens).
//
// Convenção: o nome de cada teste começa pelo ID do documento. O que o
// documento diz "Esperado" é o que o teste afirma. Quando o código AINDA NÃO
// atende (a linha "Hoje (pelo código)" do documento), o teste é marcado
// `todo` com o ID da fraqueza: a suíte fica verde, o relatório mostra a
// lacuna, e no dia em que for corrigida o teste passa a valer sozinho —
// basta tirar o `todo`.
//
// Uso: npm run test:it --workspace apps/api   (precisa do Postgres local)
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, anon, idToken, seedDataset, shutdown, db, USERS, PROJECT, baseUrl } from './harness.js'

const MASK = '•••'
let lakePrivadoFile = ''

before(async () => {
  // Conjunto aberto ao tenant, com um campo SENSÍVEL e um OCULTO — o objeto
  // de teste da §10.1 ("um calculado com um campo marcado sensível e um oculto").
  await seedDataset({
    slug: 'teste-comite-aberto',
    visibility: 'tenant',
    fields: [
      { key: 'id', type: 'number' },
      { key: 'cliente' },
      { key: 'cpf', sensitive: true },
      { key: 'senha_interna', hidden: true },
      { key: 'valor', type: 'number' },
    ],
    rowsSql: `select * from (values
      (1, 'ana', '111.111.111-11', 'oculto-1', 100.0),
      (2, 'bia', '222.222.222-22', 'oculto-2', 250.0),
      (3, 'caio', '333.333.333-33', 'oculto-3', 50.0)) t(id, cliente, cpf, senha_interna, valor)`,
  })
  // Conjunto PRIVADO de outra pessoa — "um conjunto privado sem concessão para o viewer".
  await seedDataset({
    slug: 'teste-comite-privado',
    visibility: 'private',
    owner: 'editor2',
    fields: [{ key: 'id', type: 'number' }, { key: 'nome' }, { key: 'salario', type: 'number' }],
    rowsSql: `select * from (values (1, 'SEGREDO-FOLHA', 99999.0)) t(id, nome, salario)`,
  })
  const lake = String(process.env.LAKE_ROOT).replace(/\\/g, '/')
  lakePrivadoFile = `${lake}/sebratel/teste-comite-privado/part-1.parquet`
})

after(shutdown)

// ── T-FUN-01 · Login e papéis ──────────────────────────────────────────────
describe('T-FUN-01 login e papéis', () => {
  it('T-FUN-01 viewer entra como viewer, sem admin nem master', async () => {
    const r = await as('viewer').get('/api/v1/auth/me')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.user.roles, ['viewer'])
    assert.equal(r.body.user.master, false)
  })

  it('T-FUN-01 admin entra como admin; master só quem está em MASTER_ADMIN_EMAILS', async () => {
    const admin = await as('admin').get('/api/v1/auth/me')
    assert.ok(admin.body.user.roles.includes('admin'))
    assert.equal(admin.body.user.master, false)
    const master = await as('master').get('/api/v1/auth/me')
    assert.equal(master.body.user.master, true)
  })

  it('T-FUN-01 conta fora do domínio é recusada no servidor', async () => {
    const r = await as('externo').get('/api/v1/auth/me')
    assert.equal(r.status, 401)
  })

  it('T-FUN-01 e-mail não verificado é recusado', async () => {
    const t = idToken(`nao.verificado@sebratel.com.br`, { email_verified: false })
    const r = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${t}` } })
    assert.equal(r.status, 401)
  })

  it('T-FUN-01 token de OUTRO projeto Firebase é recusado (emissor/público)', async () => {
    const t = idToken(USERS.viewer, { aud: 'outro-projeto', iss: 'https://securetoken.google.com/outro-projeto' })
    const r = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${t}` } })
    assert.equal(r.status, 401)
    assert.notEqual(PROJECT, 'outro-projeto')
  })

  it('T-FUN-01 token expirado é recusado', async () => {
    const t = idToken(USERS.viewer, { exp: Math.floor(Date.now() / 1000) - 60 })
    const r = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${t}` } })
    assert.equal(r.status, 401)
  })

  it('T-FUN-01 sem token: 401', async () => {
    const r = await anon.get('/api/v1/datasets')
    assert.equal(r.status, 401)
  })
})

// ── T-SEG-06 · Escalada de papel ───────────────────────────────────────────
describe('T-SEG-06 escalada de papel', () => {
  it('T-SEG-06 viewer não lista usuários nem muda papel (nem o próprio)', async () => {
    const v = as('viewer')
    assert.equal((await v.get('/api/v1/admin/users')).status, 403)
    const r = await v.patch(`/api/v1/admin/users/${encodeURIComponent(USERS.viewer)}/role`, { role: 'admin' })
    assert.equal(r.status, 403)
    assert.deepEqual((await v.get('/api/v1/auth/me')).body.user.roles, ['viewer'])
  })

  it('T-SEG-06 viewer não alcança conexões, auditoria nem provedores de IA', async () => {
    const v = as('viewer')
    for (const p of ['/api/v1/connections', '/api/v1/admin/audit', '/api/v1/ai/providers', '/api/v1/disk']) {
      assert.equal((await v.get(p)).status, 403, p)
    }
  })

  it('T-SEG-06 editor não aprova produto de API nem promove ninguém', async () => {
    const e = as('editor')
    assert.equal((await e.post('/api/v1/products/00000000-0000-0000-0000-000000000000/approve')).status, 403)
    const r = await e.patch(`/api/v1/admin/users/${encodeURIComponent(USERS.editor)}/role`, { role: 'admin' })
    assert.equal(r.status, 403)
  })
})

// ── T-SEG-07 · Fronteira do master ─────────────────────────────────────────
describe('T-SEG-07 fronteira do master', () => {
  it('T-SEG-07 admin não-master não muda a regra de atualização de uma FONTE', async () => {
    const id = (await db.query(`select id from datasets where slug = 'teste-comite-aberto'`)).rows[0].id
    const r = await as('admin').patch(`/api/v1/datasets/${id}/sync-config`, { cadence: 'hourly' })
    assert.equal(r.status, 403)
  })

  it('T-SEG-07 admin não-master não concede master a ninguém (nem a si)', async () => {
    const r = await as('admin').post('/api/v1/admin/masters', { email: USERS.admin })
    assert.equal(r.status, 403)
    assert.equal((await as('admin').get('/api/v1/auth/me')).body.user.master, false)
  })

  it('T-SEG-07 o master concede e revoga; o do ambiente não pode ser removido', async () => {
    const m = as('master')
    assert.equal((await m.post('/api/v1/admin/masters', { email: USERS.editor })).status < 300, true)
    assert.equal((await m.del(`/api/v1/admin/masters/${encodeURIComponent(USERS.editor)}`)).status < 300, true)
    const r = await m.del(`/api/v1/admin/masters/${encodeURIComponent(USERS.master)}`)
    assert.ok(r.status >= 400, 'master do ambiente não pode sair pela tela')
  })
})

// ── T-SEG-05 · Conjunto sem concessão ──────────────────────────────────────
describe('T-SEG-05 conjunto sem concessão', () => {
  it('T-SEG-05 o catálogo do viewer não lista o conjunto privado', async () => {
    const r = await as('viewer').get('/api/v1/datasets')
    assert.equal(r.status, 200)
    const slugs = JSON.stringify(r.body)
    assert.ok(slugs.includes('teste-comite-aberto'))
    assert.ok(!slugs.includes('teste-comite-privado'))
  })

  it('T-SEG-05 abrir e consultar pelo endereço: 403 ou 404, nunca os dados', async () => {
    const v = as('viewer')
    const det = await v.get('/api/v1/datasets/teste-comite-privado')
    assert.ok([403, 404].includes(det.status), `detalhe: ${det.status}`)
    const q = await v.post('/api/v1/datasets/teste-comite-privado/query', { select: ['nome'] })
    assert.equal(q.status, 403)
    assert.ok(!JSON.stringify(q.body).includes('SEGREDO-FOLHA'))
  })

  it('T-SEG-05 a concessão por e-mail libera só para quem recebeu', async () => {
    const dono = as('editor2')
    assert.equal((await dono.post('/api/v1/admin/datasets/teste-comite-privado/grants', { email: USERS.viewer2 })).status, 201)
    const ok = await as('viewer2').post('/api/v1/datasets/teste-comite-privado/query', { select: ['nome'] })
    assert.equal(ok.status, 200)
    assert.equal((await as('viewer').post('/api/v1/datasets/teste-comite-privado/query', { select: ['nome'] })).status, 403)
  })
})

// ── T-SEG-01 · Máscara no explorador (consulta estruturada) ────────────────
describe('T-SEG-01 máscara no explorador', () => {
  it('T-SEG-01 campo sensível sai mascarado para o viewer', async () => {
    const r = await as('viewer').post('/api/v1/datasets/teste-comite-aberto/query', { select: ['cliente', 'cpf'] })
    assert.equal(r.status, 200)
    assert.ok(r.body.rows.every((x: { cpf: string }) => x.cpf === MASK), JSON.stringify(r.body.rows))
  })

  it('T-SEG-01 campo oculto não existe para ninguém (nem admin)', async () => {
    for (const who of ['viewer', 'admin'] as const) {
      const r = await as(who).post('/api/v1/datasets/teste-comite-aberto/query', { select: ['senha_interna'] })
      assert.ok(r.status >= 400, `${who}: ${r.status}`)
      assert.ok(!JSON.stringify(r.body).includes('oculto-'))
    }
    const tudo = await as('admin').post('/api/v1/datasets/teste-comite-aberto/query', {})
    assert.ok(!JSON.stringify(tudo.body).includes('oculto-'), 'select sem lista também não traz o oculto')
  })

  it('T-SEG-01 o viewer não filtra nem agrupa pelo sensível (não vira oráculo)', async () => {
    const v = as('viewer')
    const f = await v.post('/api/v1/datasets/teste-comite-aberto/query',
      { select: ['cliente'], filters: [{ field: 'cpf', op: 'starts_with', value: '111' }] })
    assert.ok(f.status >= 400, `filtro: ${f.status}`)
    const g = await v.post('/api/v1/datasets/teste-comite-aberto/query',
      { select: ['cpf', { agg: 'count' }], groupBy: ['cpf'] })
    assert.ok(g.status >= 400, `agrupamento: ${g.status}`)
  })

  it('T-SEG-01 ordenar pelo sensível também é recusado (oráculo de ordenação)', {
    todo: 'Fraqueza conhecida: ordenar por campo sensível não é bloqueado — a ordem revela o valor.',
  }, async () => {
    const r = await as('viewer').post('/api/v1/datasets/teste-comite-aberto/query',
      { select: ['cliente'], orderBy: [{ field: 'cpf', dir: 'asc' }] })
    assert.ok(r.status >= 400, `ordenação: ${r.status}`)
  })

  it('T-SEG-01 admin vê o sensível em claro (regra atual do documento)', async () => {
    const r = await as('admin').post('/api/v1/datasets/teste-comite-aberto/query', { select: ['cpf'] })
    assert.equal(r.status, 200)
    assert.ok(r.body.rows.some((x: { cpf: string }) => x.cpf === '111.111.111-11'))
  })
})

// ── T-SEG-04 · Leitura de arquivo por SQL livre (SEG-01, corrigido) ────────
describe('T-SEG-04 leitura de arquivo por SQL livre', () => {
  const run = (sql: string) => as('viewer').post('/api/v1/notebooks/run', { sql })

  it('T-SEG-04 o notebook do viewer funciona sobre o conjunto que ele alcança', async () => {
    const r = await run('select count(*) as n from teste_comite_aberto')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(Number(r.body.rows[0].n), 3)
  })

  it('T-SEG-04 Parquet de conjunto sem concessão pelo caminho: recusado', async () => {
    const r = await run(`select * from '${lakePrivadoFile}'`)
    assert.equal(r.status, 400)
    assert.ok(!JSON.stringify(r.body).includes('SEGREDO-FOLHA'))
  })

  it('T-SEG-04 conjunto sem concessão pelo nome: recusado', async () => {
    const r = await run('select * from teste_comite_privado')
    assert.equal(r.status, 400)
    assert.ok(!JSON.stringify(r.body).includes('SEGREDO-FOLHA'))
  })

  it('T-SEG-04 arquivo fora do lake e metadados do Parquet: recusados', async () => {
    for (const sql of [
      `select * from read_text('/proc/self/environ')`,
      `select * from '/etc/passwd'`,
      `select * from parquet_metadata('${lakePrivadoFile}')`,
      `select * from query_table('teste_comite_privado')`,
    ]) {
      const r = await run(sql)
      assert.equal(r.status, 400, sql)
    }
  })
})

// ── T-SEG-02 · Máscara no notebook (SEG-02, aberto) ────────────────────────
describe('T-SEG-02 máscara no SQL livre', () => {
  it('T-SEG-02 notebook do viewer: campo sensível mascarado ou recusado', {
    todo: 'SEG-02: o SQL livre lê o Parquet completo — o CPF sai em claro para o viewer.',
  }, async () => {
    const r = await as('viewer').post('/api/v1/notebooks/run', { sql: 'select cpf from teste_comite_aberto' })
    assert.ok(r.status >= 400 || r.body.rows.every((x: { cpf: string }) => x.cpf === MASK))
  })

  it('T-SEG-02 notebook do viewer: select * não traz a coluna oculta', {
    todo: 'SEG-02: a ingestão grava as colunas ocultas no lake e o SQL livre as devolve.',
  }, async () => {
    const r = await as('viewer').post('/api/v1/notebooks/run', { sql: 'select * from teste_comite_aberto' })
    assert.ok(!JSON.stringify(r.body).includes('oculto-'))
  })
})

// ── T-SEG-13 · Segredos não voltam à tela ──────────────────────────────────
describe('T-SEG-13 segredos não voltam à tela', () => {
  it('T-SEG-13 senha de conexão não volta na listagem', async () => {
    const a = as('admin')
    const c = await a.post('/api/v1/connections', {
      kind: 'postgres', name: 'TESTE-COMITE conexão', host: '127.0.0.1', port: 1,
      database: 'nada', username: 'leitor', password: 'SENHA-DE-TESTE-NAO-PODE-VOLTAR',
    })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    const list = await a.get('/api/v1/connections')
    assert.equal(list.status, 200)
    assert.ok(!JSON.stringify(list.body).includes('SENHA-DE-TESTE-NAO-PODE-VOLTAR'))
  })

  it('T-SEG-13 chave de provedor de IA não volta na listagem', async () => {
    const a = as('admin')
    const p = await a.post('/api/v1/ai/providers', {
      name: 'TESTE-COMITE IA', kind: 'anthropic', model: 'modelo-de-teste', apiKey: 'sk-CHAVE-DE-TESTE-NAO-PODE-VOLTAR',
    })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.ok(!JSON.stringify(p.body).includes('CHAVE-DE-TESTE'))
    assert.ok(!JSON.stringify((await a.get('/api/v1/ai/providers')).body).includes('CHAVE-DE-TESTE'))
  })

  it('T-SEG-13 segredo de upstream do gateway não volta na listagem', async () => {
    const e = as('editor')
    const u = await e.post('/api/v1/gateway/upstreams', {
      slug: 'teste-segredo', name: 'TESTE-COMITE upstream', baseUrl: 'http://127.0.0.1:9/api',
      authMode: 'header', authHeader: 'X-Chave', secret: 'SEGREDO-UPSTREAM-NAO-PODE-VOLTAR',
    })
    assert.equal(u.status, 201, JSON.stringify(u.body))
    assert.ok(!JSON.stringify(u.body).includes('SEGREDO-UPSTREAM'))
    assert.ok(!JSON.stringify((await e.get('/api/v1/gateway/upstreams')).body).includes('SEGREDO-UPSTREAM'))
  })
})

// ── T-FUN-12 · Token e API pública ─────────────────────────────────────────
describe('T-FUN-12 token e API pública', () => {
  let token = ''
  let id = ''

  before(async () => {
    const r = await as('editor').post('/api/v1/credentials', {
      name: 'TESTE-COMITE token', datasetSlugs: ['teste-comite-aberto'], expiresInDays: 7,
    })
    assert.equal(r.status, 201)
    token = r.body.token
    id = r.body.id
  })

  it('T-FUN-12 /rows e POST /query respondem com o cabeçalho X-Api-Token', async () => {
    const rows = await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows', token)
    assert.equal(rows.status, 200, JSON.stringify(rows.body))
    assert.equal(rows.body.rows.length, 3)
    const q = await anon.post('/api/public/v1/datasets/teste-comite-aberto/query',
      { select: ['cliente', { field: 'valor', agg: 'sum', as: 'total' }], groupBy: ['cliente'] }, token)
    assert.equal(q.status, 200, JSON.stringify(q.body))
    assert.equal(q.body.rows.length, 3)
  })

  it('T-FUN-12 pelo token, o sensível sai mascarado e o oculto não existe', async () => {
    const rows = await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows', token)
    const txt = JSON.stringify(rows.body)
    assert.ok(!txt.includes('111.111.111-11'))
    assert.ok(!txt.includes('oculto-'))
  })

  it('T-FUN-12 conjunto fora do escopo do token: 403', async () => {
    const r = await anon.get('/api/public/v1/datasets/teste-comite-privado/rows', token)
    assert.equal(r.status, 403)
  })

  it('T-FUN-12 depois de revogar: 401', async () => {
    assert.equal((await as('editor').patch(`/api/v1/credentials/${id}`, { revoked: true })).status, 200)
    const r = await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows', token)
    assert.equal(r.status, 401)
  })

  it('T-FUN-12 sem token: 401', async () => {
    assert.equal((await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows')).status, 401)
  })
})

// ── T-SEG-08 / 09 / 10 / 16 · Tokens (SEG-03, SEG-06) ──────────────────────
describe('T-SEG-08..10, T-SEG-16 tokens', () => {
  it('T-SEG-08 token com escopo vazio NÃO lê conjunto privado de outra pessoa', {
    todo: 'SEG-03: escopo vazio libera todos os conjuntos, inclusive privados de terceiros.',
  }, async () => {
    const r = await as('editor').post('/api/v1/credentials', { name: 'TESTE-COMITE escopo vazio', datasetSlugs: [] })
    const lido = await anon.get('/api/public/v1/datasets/teste-comite-privado/rows', r.body.token)
    assert.notEqual(lido.status, 200, 'leu o conjunto privado de outra pessoa')
    assert.ok(!JSON.stringify(lido.body).includes('SEGREDO-FOLHA'))
  })

  it('T-SEG-09 o viewer vê só os próprios tokens', {
    todo: 'SEG-03: qualquer usuário logado lista todos os tokens, com dono e escopo.',
  }, async () => {
    const r = await as('viewer').get('/api/v1/credentials')
    assert.equal(r.status, 200)
    assert.ok(r.body.credentials.every((c: { owner_email: string }) => c.owner_email === USERS.viewer))
  })

  it('T-SEG-09 um editor não altera o escopo do token de outro editor', {
    todo: 'SEG-03: o PATCH de token não confere o dono — qualquer editor amplia o escopo de qualquer token.',
  }, async () => {
    const r = await as('editor').post('/api/v1/credentials', { name: 'TESTE-COMITE do editor', datasetSlugs: ['teste-comite-aberto'] })
    const patch = await as('editor2').patch(`/api/v1/credentials/${r.body.id}`, { datasetSlugs: [] })
    assert.equal(patch.status, 403)
  })

  it('T-SEG-10 token na URL (?token=) não é aceito', {
    todo: 'SEG-06: ?token= é aceito — vai para log do nginx, histórico e Referer.',
  }, async () => {
    const r = await as('editor').post('/api/v1/credentials', { name: 'TESTE-COMITE url', datasetSlugs: ['teste-comite-aberto'] })
    const viaUrl = await anon.get(`/api/public/v1/datasets/teste-comite-aberto/rows?token=${r.body.token}`)
    assert.equal(viaUrl.status, 401)
  })

  it('T-SEG-16 cota de 5 por dia: a 6ª chamada recebe 429', async () => {
    const t = await as('editor').post('/api/v1/credentials', { name: 'TESTE-COMITE cota', datasetSlugs: ['teste-comite-aberto'] })
    const pol = await as('admin').put(`/api/v1/gateway/credentials/${t.body.id}/policy`, { quotaPerDay: 5 })
    assert.equal(pol.status, 200, JSON.stringify(pol.body))
    const status: number[] = []
    for (let i = 0; i < 6; i++) status.push((await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows?limit=1', t.body.token)).status)
    assert.deepEqual(status, [200, 200, 200, 200, 200, 429])
  })
})

// ── T-SEG-11 · Upstream redirecionado (SEG-04) ─────────────────────────────
describe('T-SEG-11 upstream redirecionado', () => {
  it('T-SEG-11 upstream criado por editor nasce pendente', async () => {
    const r = await as('editor').post('/api/v1/gateway/upstreams', {
      slug: 'teste-pendente', name: 'TESTE-COMITE pendente', baseUrl: 'http://127.0.0.1:9/a',
    })
    assert.equal(r.status, 201)
    assert.equal(r.body.upstream.status, 'pending')
  })

  it('T-SEG-11 mudar o endereço de um upstream aprovado o devolve para pendente', {
    todo: 'SEG-04: o editor troca a base_url de um upstream aprovado e ele segue ativo, levando a credencial.',
  }, async () => {
    const e = as('editor')
    const c = await e.post('/api/v1/gateway/upstreams', {
      slug: 'teste-aprovado', name: 'TESTE-COMITE aprovado', baseUrl: 'http://127.0.0.1:9/interno',
      authMode: 'header', authHeader: 'X-Chave', secret: 'credencial-do-upstream',
    })
    const id = c.body.upstream.id
    assert.equal((await as('admin').post(`/api/v1/gateway/upstreams/${id}/review`, { status: 'active' })).status, 200)
    const ed = await e.put(`/api/v1/gateway/upstreams/${id}`, {
      slug: 'teste-aprovado', name: 'TESTE-COMITE aprovado', baseUrl: 'http://atacante.exemplo/coleta',
      authMode: 'header', authHeader: 'X-Chave',
    })
    assert.equal(ed.status, 200)
    assert.equal(ed.body.upstream.status, 'pending')
  })
})
