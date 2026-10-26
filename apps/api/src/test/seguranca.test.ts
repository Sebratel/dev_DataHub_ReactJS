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
import { as, anon, idToken, seedDataset, shutdown, db, waitFor, USERS, PROJECT, baseUrl } from './harness.js'

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

  it('T-SEG-06 rebaixar o papel vale na requisição seguinte, mesmo com a sessão em cache', async () => {
    // O MESMO token do começo ao fim: é ele que fica no cache de sessão (5 min).
    // Antes da correção, o admin rebaixado seguia admin até o cache vencer.
    const c = as('viewer2')
    const promove = (role: string) =>
      as('admin').patch(`/api/v1/admin/users/${encodeURIComponent(USERS.viewer2)}/role`, { role })
    assert.equal((await c.get('/api/v1/admin/users')).status, 403)
    assert.equal((await promove('admin')).status, 200)
    assert.equal((await c.get('/api/v1/admin/users')).status, 200, 'promoção não valeu na hora')
    assert.equal((await promove('viewer')).status, 200)
    assert.equal((await c.get('/api/v1/admin/users')).status, 403, 'rebaixado continuou admin')
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

// ── T-SEG-02 / 03 · Máscara e export no notebook (SEG-02, D-SEG-2) ─────────
describe('T-SEG-02 máscara no SQL livre', () => {
  const run = (who: 'viewer' | 'admin', sql: string) => as(who).post('/api/v1/notebooks/run', { sql })

  it('T-SEG-02 notebook do viewer: campo sensível mascarado', async () => {
    const r = await run('viewer', 'select cpf from teste_comite_aberto')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.rows.length, 3)
    assert.ok(r.body.rows.every((x: { cpf: string }) => x.cpf === MASK), JSON.stringify(r.body.rows))
  })

  it('T-SEG-02 notebook do viewer: select * não traz a coluna oculta', async () => {
    const r = await run('viewer', 'select * from teste_comite_aberto')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(!r.body.columns.includes('senha_interna'))
    assert.ok(!JSON.stringify(r.body).includes('oculto-'))
    assert.ok(!JSON.stringify(r.body).includes('111.111.111-11'))
  })

  it('T-SEG-02 o viewer não reconstrói o sensível por filtro, ordem ou função', async () => {
    // Filtro pelo valor real: a coluna que ele enxerga JÁ é a máscara, então nada casa.
    const f = await run('viewer', `select cliente from teste_comite_aberto where cpf = '111.111.111-11'`)
    assert.equal(f.status, 200)
    assert.equal(f.body.rows.length, 0, 'o filtro pelo CPF real achou a linha')
    // Ordem: todos valem a máscara; a ordem não carrega nada do CPF.
    const o = await run('viewer', 'select cliente, cpf from teste_comite_aberto order by cpf desc, cliente')
    assert.deepEqual(o.body.rows.map((x: { cliente: string }) => x.cliente), ['ana', 'bia', 'caio'])
    const g = await run('viewer', 'select count(distinct cpf) as n, max(length(cpf)) as l from teste_comite_aberto')
    assert.equal(Number(g.body.rows[0].n), 1)
    assert.equal(Number(g.body.rows[0].l), MASK.length)
  })

  it('T-SEG-02 a proteção vale também pelo slug entre aspas e dentro de CTE própria', async () => {
    const r = await run('viewer',
      `with base as (select * from "teste-comite-aberto") select b.cpf from base b join teste_comite_aberto t on t.id = b.id`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.rows.every((x: { cpf: string }) => x.cpf === MASK))
  })

  it('T-SEG-02 admin: sensível em claro (como na tela), oculto ausente', async () => {
    const r = await run('admin', 'select * from teste_comite_aberto order by id')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.rows[0].cpf, '111.111.111-11')
    assert.ok(!r.body.columns.includes('senha_interna'))
    assert.ok(!JSON.stringify(r.body).includes('oculto-'))
  })

  it('T-SEG-02 SQL sem conjunto nenhum segue funcionando', async () => {
    const r = await run('viewer', 'select 1 as um')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(Number(r.body.rows[0].um), 1)
  })
})

describe('T-SEG-03 export do notebook', () => {
  const exporta = (who: 'viewer' | 'viewer2', sql: string) =>
    as(who).post('/api/v1/notebooks/export', { sql, notebook: 'teste-export' })

  before(async () => {
    // Privado, com concessão de LEITURA ao viewer, mas sem exportação.
    await seedDataset({
      slug: 'teste-comite-sem-export',
      visibility: 'private',
      owner: 'editor2',
      fields: [{ key: 'id', type: 'number' }, { key: 'contrato' }],
      rowsSql: `select * from (values (1, 'C-1'), (2, 'C-2')) t(id, contrato)`,
    })
    const g = await as('editor2').post('/api/v1/admin/datasets/teste-comite-sem-export/grants',
      { email: USERS.viewer, canExport: false })
    assert.equal(g.status, 201, JSON.stringify(g.body))
  })

  it('T-SEG-03 sem permissão de exportar: lê no notebook, mas o export é recusado', async () => {
    assert.equal((await as('viewer').post('/api/v1/notebooks/run', { sql: 'select * from teste_comite_sem_export' })).status, 200)
    const r = await exporta('viewer', 'select * from teste_comite_sem_export')
    assert.equal(r.status, 403)
    assert.ok(!JSON.stringify(r.body).includes('C-1'))
  })

  it('T-SEG-03 um join com um conjunto sem exportação também é recusado', async () => {
    const r = await exporta('viewer',
      'select a.cliente, s.contrato from teste_comite_aberto a join teste_comite_sem_export s on s.id = a.id')
    assert.equal(r.status, 403)
  })

  it('T-SEG-03 com permissão: o CSV sai do servidor, mascarado e sem a oculta', async () => {
    const r = await exporta('viewer', 'select * from teste_comite_aberto')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/)
    const csv = String(r.body)
    assert.equal(csv.trim().split(/\r?\n/).length, 4, 'cabeçalho + 3 linhas')
    assert.ok(csv.includes(MASK))
    assert.ok(!csv.includes('111.111.111-11'))
    assert.ok(!csv.includes('senha_interna') && !csv.includes('oculto-'))
  })

  it('T-SEG-03 a exportação do notebook fica na auditoria, com os conjuntos e as linhas', async () => {
    const ev = await waitFor(async () => (await db.query(
      `select detail from audit_logs where user_email = $1 and action = 'notebooks.export' order by created_at desc limit 1`,
      [USERS.viewer])).rows[0])
    assert.ok(ev, 'nenhum notebooks.export do viewer na auditoria')
    const detail = typeof ev!.detail === 'string' ? JSON.parse(ev!.detail) : ev!.detail
    assert.equal(detail.rows, 3)
    assert.deepEqual(detail.datasets, ['teste-comite-aberto'])
  })
})

// ── T-SEG-14 · IA e dado pessoal (SEG-05) ──────────────────────────────────
// Sem provedor no teste: a ferramenta da IA é chamada direto, e o que ela
// devolve é exatamente o que iria para o provedor.
describe('T-SEG-14 IA e dado pessoal', () => {
  const sessao = (who: 'admin' | 'viewer') => ({
    email: USERS[who], name: who, roles: [who], tenant: 'sebratel', master: false, masterConfigured: true,
  })

  it('T-SEG-14 o que a IA recebe vem mascarado também para o admin', async () => {
    const { executeTool } = await import('../modules/ai/tools.js')
    for (const who of ['admin', 'viewer'] as const) {
      const r = await executeTool('run_query', { dataset: 'teste-comite-aberto', select: ['cliente', 'cpf'] }, sessao(who))
      assert.ok(!r.isError, `${who}: ${r.content}`)
      const { rows } = JSON.parse(r.content) as { rows: { cpf: string }[] }
      assert.equal(rows.length, 3)
      assert.ok(rows.every((x) => x.cpf === MASK), `${who} recebeu o CPF em claro`)
      assert.ok(!r.content.includes('111.111.111-11'))
    }
  })

  it('T-SEG-14 nem o admin filtra ou agrupa pelo sensível pela IA (não vira oráculo)', async () => {
    const { executeTool } = await import('../modules/ai/tools.js')
    const f = await executeTool('run_query', {
      dataset: 'teste-comite-aberto', select: ['cliente'], filters: [{ field: 'cpf', op: 'starts_with', value: '111' }],
    }, sessao('admin'))
    assert.equal(f.isError, true)
    const g = await executeTool('run_query', {
      dataset: 'teste-comite-aberto', select: ['cpf', { agg: 'count', as: 'n' }], groupBy: ['cpf'],
    }, sessao('admin'))
    assert.equal(g.isError, true)
  })

  it('T-SEG-14 a tela do admin segue mostrando o sensível (a regra muda só para a IA)', async () => {
    const r = await as('admin').post('/api/v1/datasets/teste-comite-aberto/query', { select: ['cpf'] })
    assert.ok(r.body.rows.some((x: { cpf: string }) => x.cpf === '111.111.111-11'))
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
    const r = await as('admin').post('/api/v1/credentials', {
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
    assert.equal((await as('admin').patch(`/api/v1/credentials/${id}`, { revoked: true })).status, 200)
    const r = await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows', token)
    assert.equal(r.status, 401)
  })

  it('T-FUN-12 sem token: 401', async () => {
    assert.equal((await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows')).status, 401)
  })
})

// ── T-SEG-08 / 09 / 10 / 16 · Tokens (SEG-03, SEG-06) ──────────────────────
// D-SEG-3 (R3): criar, ver, editar e revogar token é só de admin. O escopo
// vazio continua valendo "todos" — conforme pela visão de negócio, porque só
// quem já lê tudo consegue emiti-lo.
describe('T-SEG-08..10, T-SEG-16 tokens', () => {
  it('T-SEG-08 editor não cria token (só admins têm token)', async () => {
    const r = await as('editor').post('/api/v1/credentials', { name: 'TESTE-COMITE escopo vazio', datasetSlugs: [] })
    assert.equal(r.status, 403)
    assert.equal(r.body.token, undefined)
  })

  it('T-SEG-09 viewer e editor não listam tokens', async () => {
    for (const who of ['viewer', 'editor'] as const) {
      const r = await as(who).get('/api/v1/credentials')
      assert.equal(r.status, 403, who)
      assert.ok(!JSON.stringify(r.body).includes('TESTE-COMITE'), `${who} viu nomes de token`)
    }
  })

  it('T-SEG-09 editor não altera, não revoga e não exclui token de ninguém', async () => {
    const t = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE do admin', datasetSlugs: ['teste-comite-aberto'] })
    assert.equal(t.status, 201)
    const e = as('editor')
    assert.equal((await e.patch(`/api/v1/credentials/${t.body.id}`, { datasetSlugs: [] })).status, 403)
    assert.equal((await e.patch(`/api/v1/credentials/${t.body.id}`, { revoked: true })).status, 403)
    assert.equal((await e.del(`/api/v1/credentials/${t.body.id}`)).status, 403)
    const row = (await db.query('select dataset_slugs, revoked from api_credentials where id = $1', [t.body.id])).rows[0]
    assert.deepEqual(row.dataset_slugs, ['teste-comite-aberto'], 'o escopo mudou')
    assert.equal(row.revoked, false)
  })

  it('T-SEG-09 o consumo por token do gateway também é só de admin', async () => {
    assert.equal((await as('editor').get('/api/v1/gateway/usage')).status, 403)
    assert.equal((await as('admin').get('/api/v1/gateway/usage')).status, 200)
  })

  it('T-SEG-10 token na URL (?token=) não é aceito, e a recusa diz como enviar', async () => {
    const r = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE url', datasetSlugs: ['teste-comite-aberto'] })
    const viaUrl = await anon.get(`/api/public/v1/datasets/teste-comite-aberto/rows?token=${r.body.token}`)
    assert.equal(viaUrl.status, 401)
    assert.match(viaUrl.body.error, /X-Api-Token/)
    assert.ok(!JSON.stringify(viaUrl.body).includes('ana'), 'devolveu dados')
    // Também com o cabeçalho junto: o token na URL já vazou para o log, e
    // aceitar ensinaria o cliente a continuar mandando.
    const ambos = await anon.get(`/api/public/v1/datasets/teste-comite-aberto/rows?token=${r.body.token}`, r.body.token)
    assert.equal(ambos.status, 401)
    const q = await anon.post(`/api/public/v1/datasets/teste-comite-aberto/query?token=${r.body.token}`, { select: ['cliente'] })
    assert.equal(q.status, 401)
  })

  it('T-SEG-10 a recusa por token na URL fica na telemetria com motivo próprio', async () => {
    await anon.get('/api/public/v1/datasets/teste-comite-aberto/rows?token=qualquer')
    const linha = await waitFor(async () => (await db.query(
      `select error from api_call_metrics where error = 'token na URL' limit 1`)).rows[0], 5_000)
    assert.ok(linha, 'a recusa não aparece na telemetria — não daria para achar quem falta migrar')
  })

  it('T-SEG-10 gateway: token do Data Hub só pelo cabeçalho', async () => {
    const r = await anon.get('/api/public/v1/gw/qualquer/x?token=dhub_nao_vale')
    assert.equal(r.status, 401)
    assert.match(r.body.error, /X-Api-Token/)
  })

  it('T-SEG-16 cota de 5 por dia: a 6ª chamada recebe 429', async () => {
    const t = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE cota', datasetSlugs: ['teste-comite-aberto'] })
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

  // Upstream aprovado com credencial — o alvo de todos os casos abaixo.
  async function aprovado(slug: string, aprovador: 'admin' | 'master' = 'admin') {
    const c = await as('editor').post('/api/v1/gateway/upstreams', {
      slug, name: `TESTE-COMITE ${slug}`, baseUrl: 'http://127.0.0.1:9/interno',
      authMode: 'header', authHeader: 'X-Chave', secret: 'credencial-do-upstream',
    })
    const id = c.body.upstream.id as string
    assert.equal((await as(aprovador).post(`/api/v1/gateway/upstreams/${id}/review`, { status: 'active' })).status, 200)
    return id
  }
  const edita = (who: 'editor' | 'admin', id: string, slug: string, over: Record<string, unknown> = {}) =>
    as(who).put(`/api/v1/gateway/upstreams/${id}`, {
      slug, name: `TESTE-COMITE ${slug}`, baseUrl: 'http://127.0.0.1:9/interno',
      authMode: 'header', authHeader: 'X-Chave', ...over,
    })

  it('T-SEG-11 mudar o endereço de um upstream aprovado o devolve para pendente', async () => {
    const id = await aprovado('teste-aprovado')
    const ed = await edita('editor', id, 'teste-aprovado', { baseUrl: 'http://atacante.exemplo/coleta' })
    assert.equal(ed.status, 200)
    assert.equal(ed.body.upstream.status, 'pending')
    assert.deepEqual(ed.body.reaprovar, ['endereço'])
  })

  it('T-SEG-11 trocar o segredo ou ampliar os métodos também devolve para pendente', async () => {
    const id1 = await aprovado('teste-segredo-novo')
    const s = await edita('editor', id1, 'teste-segredo-novo', { secret: 'outra-credencial' })
    assert.equal(s.body.upstream.status, 'pending')
    const id2 = await aprovado('teste-metodos')
    const m = await edita('editor', id2, 'teste-metodos', { methods: ['GET', 'DELETE'] })
    assert.equal(m.body.upstream.status, 'pending')
  })

  it('T-SEG-11 mudar só o nome mantém o upstream no ar', async () => {
    const id = await aprovado('teste-so-nome')
    const ed = await edita('editor', id, 'teste-so-nome', { name: 'TESTE-COMITE outro nome', description: 'nova' })
    assert.equal(ed.body.upstream.status, 'active')
  })

  it('T-SEG-11 a edição do admin vale como nova aprovação, e o registro diz quem aprovou', async () => {
    // Aprovado pelo master; o admin muda o destino. Sem a correção, o registro
    // seguiria dizendo que o master aprovou um endereço que ele nunca viu.
    const id = await aprovado('teste-admin-edita', 'master')
    const ed = await edita('admin', id, 'teste-admin-edita', { baseUrl: 'http://127.0.0.1:9/novo' })
    assert.equal(ed.body.upstream.status, 'active')
    assert.equal(ed.body.upstream.reviewedBy, USERS.admin)
  })
})
