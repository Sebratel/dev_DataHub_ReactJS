// ─────────────────────────────────────────────────────────────────────────
// Assistente como analista (27/11/2026): SQL com JOIN, conhecimento por
// tabela de origem, perfil automático, notas da equipe, notebook com a
// análise e a avaliação com gabarito calculado na hora.
//
// Sem provedor de verdade: as ferramentas são chamadas direto (o que elas
// devolvem é exatamente o que iria para o provedor) e, onde o loop importa,
// um provedor FALSO faz o papel do modelo.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, seedDataset, USERS } from './harness.js'
import type { AIProvider, AiMessage, AiToolDef, AiTurn, ChatOptions } from '../modules/ai/provider.js'

type Tools = typeof import('../modules/ai/tools.js')
let executeTool: Tools['executeTool']
const usuario = (who: 'admin' | 'viewer' | 'editor') => ({
  email: USERS[who], name: who, roles: [who], tenant: 'sebratel', master: false, masterConfigured: true,
}) as never

async function tool(name: string, input: Record<string, unknown>, who: 'admin' | 'viewer' | 'editor' = 'viewer') {
  const r = await executeTool(name, input, usuario(who))
  let json: any = null
  if (!r.isError) { try { json = JSON.parse(r.content) } catch { /* texto */ } }
  return { ...r, json }
}

before(async () => {
  ;({ executeTool } = await import('../modules/ai/tools.js'))
  const contratos = await seedDataset({
    slug: 'contratos-teste', objectName: 'contracts',
    fields: [
      { key: 'id', type: 'number' }, { key: 'status' }, { key: 'cidade' }, { key: 'amount', type: 'number' },
      { key: 'cpf', sensitive: true }, { key: 'observacao', hidden: true },
    ],
    rowsSql: `select * from (values
      (1, 'ativo', 'Canoas', 100.0, '11111111111', 'x'),
      (2, 'ativo', 'Canoas', 120.0, '22222222222', 'x'),
      (3, 'cancelado', 'Esteio', 90.0, '33333333333', 'x'),
      (4, 'ativo', 'São Leopoldo', 150.0, '44444444444', 'x')
    ) t(id, status, cidade, amount, cpf, observacao)`,
  })
  // Como uma cópia do Voalle: a tabela de origem é erp.contracts.
  await db.query(`update datasets set schema_name = 'erp' where id = $1`, [contratos])
  await seedDataset({
    slug: 'faturas-teste',
    fields: [{ key: 'contrato_id', type: 'number' }, { key: 'saldo', type: 'number' }],
    rowsSql: `select * from (values (1, 0.0), (2, 50.0), (2, 30.0), (3, 90.0)) t(contrato_id, saldo)`,
  })
  await seedDataset({
    slug: 'privado-do-editor', visibility: 'private', owner: 'editor',
    fields: [{ key: 'tag' }], rowsSql: `select 'X' as tag`,
  })
  await seedDataset({
    slug: 'muitas-linhas', fields: [{ key: 'n', type: 'number' }],
    rowsSql: 'select range as n from range(300)',
  })
  // Um "ouro" de pacote no lake, para o mapa e para a avaliação.
  await seedDataset({
    slug: 'ouro_base_ativa_mensal',
    fields: [{ key: 'mes', type: 'date' }, { key: 'contratos_ativos', type: 'number' }, { key: 'arpu', type: 'number' }],
    rowsSql: `select * from (values (date '2026-10-01', 87012, 101.5), (date '2026-11-01', 87788, 102.25)) t(mes, contratos_ativos, arpu)`,
  })
  // Um calculado: o SQL dele é a documentação que o assistente lê.
  const calc = await seedDataset({
    slug: 'calc-por-cidade', fields: [{ key: 'cidade' }, { key: 'n', type: 'number' }],
    rowsSql: `select 'Canoas' as cidade, 2 as n`,
  })
  await db.query(`update datasets set kind = 'derived', transform_sql = $2 where id = $1`,
    [calc, 'select cidade, count(*) as n from contratos_teste group by 1'])
})
after(shutdown)

describe('run_sql: SQL livre pela porta do notebook', () => {
  it('junta dois conjuntos e agrega', async () => {
    const r = await tool('run_sql', {
      sql: `select c.cidade, sum(f.saldo) as em_aberto
              from contratos_teste c join faturas_teste f on f.contrato_id = c.id
             where c.status = 'ativo' group by 1 order by 1`,
    })
    assert.equal(r.isError, undefined, r.content)
    assert.deepEqual(r.json.linhas.map((l: any) => [l.cidade, Number(l.em_aberto)]), [['Canoas', 80]])
    assert.equal(r.json.rowCount, 1)
    assert.equal(r.json.truncado, false)
  })

  it('aceita o nome da tabela de origem (SQL do Postgres)', async () => {
    const r = await tool('run_sql', { sql: 'select count(*)::int as n from erp.contracts' })
    assert.equal(r.isError, undefined, r.content)
    assert.equal(Number(r.json.linhas[0].n), 4)
  })

  it('conjunto que a pessoa não lê não existe para a IA dela', async () => {
    const r = await tool('run_sql', { sql: 'select * from privado_do_editor' }, 'viewer')
    assert.equal(r.isError, true)
    assert.match(r.content, /acesso|não existe/i)
  })

  it('campo sensível vem mascarado — também para admin (SEG-05)', async () => {
    const r = await tool('run_sql', { sql: 'select distinct cpf from contratos_teste' }, 'admin')
    assert.equal(r.isError, undefined, r.content)
    assert.deepEqual(r.json.linhas.map((l: any) => l.cpf), ['•••'])
  })

  it('campo oculto não existe', async () => {
    const r = await tool('run_sql', { sql: 'select observacao from contratos_teste' }, 'admin')
    assert.equal(r.isError, true)
  })

  it('só leitura: escrita, arquivo e anexo são recusados', async () => {
    for (const sql of [
      'delete from contratos_teste',
      `copy (select 1) to 'x.csv'`,
      `select * from read_parquet('/etc/passwd')`,
      `attach 'x.db'`,
      'select 1; select 2',
    ]) {
      const r = await tool('run_sql', { sql }, 'admin')
      assert.equal(r.isError, true, `deveria recusar: ${sql}`)
    }
  })

  it('resultado grande volta cortado, com o aviso para agregar', async () => {
    const r = await tool('run_sql', { sql: 'select n from muitas_linhas' })
    assert.equal(r.json.rowCount, 200)
    assert.equal(r.json.truncado, true)
    assert.match(r.json.aviso, /Agregue/)
  })

  it('erro de SQL volta como mensagem que dá para corrigir', async () => {
    const r = await tool('run_sql', { sql: 'select coluna_que_nao_existe from contratos_teste' })
    assert.equal(r.isError, true)
    assert.match(r.content, /coluna_que_nao_existe/)
  })
})

describe('get_dataset_schema: entender antes de consultar', () => {
  it('traz o conhecimento da tabela de origem, o perfil e o nome no SQL', async () => {
    const r = await tool('get_dataset_schema', { slug: 'contratos-teste' })
    assert.equal(r.isError, undefined, r.content)
    const j = r.json
    assert.equal(j.nome_no_sql, 'contratos_teste')
    assert.equal(j.tabela_de_origem, 'erp.contracts')
    assert.match(j.conhecimento.resumo, /Contratos/)
    assert.ok(j.conhecimento.armadilhas.some((a: string) => /Telefonia/.test(a)))
    const status = j.fields.find((f: any) => f.key === 'status')
    assert.match(status.nota, /cancelado/)
    assert.deepEqual(status.valores, [{ valor: 'ativo', linhas: 3 }, { valor: 'cancelado', linhas: 1 }])
    assert.equal(j.linhas, 4)
    assert.ok(j.chave_provavel.includes('id'), JSON.stringify(j.chave_provavel))
  })

  it('campo sensível aparece sem nenhum valor; oculto não aparece', async () => {
    const j = (await tool('get_dataset_schema', { slug: 'contratos-teste' }, 'admin')).json
    const cpf = j.fields.find((f: any) => f.key === 'cpf')
    assert.ok(cpf.sensivel)
    for (const k of ['valores', 'exemplos', 'min', 'max']) assert.equal(cpf[k], undefined, `cpf.${k}`)
    assert.ok(!j.fields.some((f: any) => f.key === 'observacao'))
    assert.ok(!JSON.stringify(j).includes('11111111111'))
  })

  it('calculado traz o SQL que o calcula', async () => {
    const j = (await tool('get_dataset_schema', { slug: 'calc-por-cidade' })).json
    assert.equal(j.tipo, 'calculado')
    assert.match(j.sql_do_calculo, /group by/)
  })

  it('conjunto de pacote traz a descrição do pacote', async () => {
    const j = (await tool('get_dataset_schema', { slug: 'ouro_base_ativa_mensal' })).json
    assert.match(j.conhecimento.pacote, /Onda 1/)
    assert.match(j.conhecimento.resumo, /último dia de cada mês/)
  })
})

describe('notas da equipe (ensinar o assistente)', () => {
  it('quem lê vê; só admin ou dono escreve', async () => {
    const g = await as('viewer').get('/api/v1/ai/knowledge/contratos-teste?perfil=false')
    assert.equal(g.status, 200, JSON.stringify(g.body))
    assert.equal(g.body.podeEnsinar, false)
    assert.equal((await as('viewer').put('/api/v1/ai/knowledge/contratos-teste', { notas: 'x' })).status, 403)
    const p = await as('admin').put('/api/v1/ai/knowledge/contratos-teste', { notas: 'Valor em reais, sem centavos.' })
    assert.equal(p.status, 200, JSON.stringify(p.body))
    const j = (await tool('get_dataset_schema', { slug: 'contratos-teste' })).json
    assert.equal(j.conhecimento.notas_da_equipe, 'Valor em reais, sem centavos.')
    // E de novo: a segunda gravação substitui (upsert nos dois bancos).
    assert.equal((await as('admin').put('/api/v1/ai/knowledge/contratos-teste', { notas: 'Versão 2.' })).status, 200)
    assert.equal((await as('viewer').get('/api/v1/ai/knowledge/contratos-teste?perfil=false')).body.notas, 'Versão 2.')
  })

  it('o dono ensina sobre o próprio conjunto; quem não lê nem vê', async () => {
    assert.equal((await as('editor').put('/api/v1/ai/knowledge/privado-do-editor', { notas: 'Tags do Matrix.' })).status, 200)
    assert.equal((await as('viewer').get('/api/v1/ai/knowledge/privado-do-editor')).status, 404)
  })

  it('texto grande demais é recusado (vai em toda pergunta)', async () => {
    const r = await as('admin').put('/api/v1/ai/knowledge/contratos-teste', { notas: 'x'.repeat(8_001) })
    assert.equal(r.status, 400)
  })
})

describe('create_notebook: a análise que sobrevive à conversa', () => {
  it('salva privado, no nome de quem perguntou', async () => {
    const r = await tool('create_notebook', {
      name: 'Saldo por cidade', description: 'Teste',
      cells: [
        { kind: 'markdown', source: '## Contexto' },
        { kind: 'sql', source: 'select cidade, count(*) from contratos_teste group by 1' },
      ],
    }, 'viewer')
    assert.equal(r.isError, undefined, r.content)
    assert.equal(r.notebook?.slug, 'saldo-por-cidade')
    const nb = (await db.query(`select visibility, owner_email, cells from notebooks where slug = 'saldo-por-cidade'`)).rows[0]
    assert.equal(nb.visibility, 'private')
    assert.equal(nb.owner_email, USERS.viewer)
    const cells = typeof nb.cells === 'string' ? JSON.parse(nb.cells) : nb.cells
    assert.equal(cells.length, 2)
  })

  it('SQL quebrado: nada é salvo, e o erro diz a célula', async () => {
    const r = await tool('create_notebook', {
      name: 'Quebrado', cells: [{ kind: 'sql', source: 'select * from privado_do_editor' }],
    }, 'viewer')
    assert.equal(r.isError, true)
    assert.match(r.content, /célula 1/)
    assert.equal(Number((await db.query(`select count(*) as n from notebooks where slug = 'quebrado'`)).rows[0].n), 0)
  })

  it('no construtor de widgets (escopo fechado) SQL livre não existe', async () => {
    const r = await executeTool('run_sql', { sql: 'select 1' }, usuario('admin'), new Set(['contratos-teste']))
    assert.equal(r.isError, true)
  })
})

describe('prompt: regras, mapa e histórico', () => {
  it('o mapa traz só os conjuntos de pacote que estão no lake', async () => {
    const { montaSistema } = await import('../modules/ai/assistant.js')
    const s = await montaSistema(usuario('viewer'))
    assert.match(s, /bill_title_id vazio/)
    assert.match(s, /- ouro_base_ativa_mensal — Base ativa por mês/)
    assert.ok(!s.includes('ouro_cancelamento_mensal —'))
  })

  it('o histórico leva o SQL que a resposta anterior usou', async () => {
    const { historicoParaModelo } = await import('../modules/ai/assistant.js')
    const h = historicoParaModelo([
      { role: 'user', content: 'quantos ativos?' },
      { role: 'assistant', content: 'São 3.', trace: [
        { name: 'run_sql', alvo: null, erro: false, sql: 'select count(*) from contratos_teste' },
        { name: 'run_sql', alvo: null, erro: true, sql: 'select errado' },
      ] },
    ])
    assert.equal(h[0].content, 'quantos ativos?')
    assert.match(String(h[1].content), /select count\(\*\) from contratos_teste/)
    assert.ok(!String(h[1].content).includes('select errado'))
  })

  it('teto de tempo: responde com o que tem', async () => {
    const { runAgent } = await import('../modules/ai/agent.js')
    let chamadas = 0
    const p: AIProvider = {
      name: 'falso', model: 'falso', isConfigured: () => true, listModels: async () => [],
      toolResultMessage: (results) => ({ role: 'user', content: results }),
      async chat(_s: string, _m: AiMessage[], _t: AiToolDef[], opts?: ChatOptions): Promise<AiTurn> {
        chamadas++
        if (opts?.toolChoice === 'none') return { text: 'Parcial.', toolCalls: [], raw: null }
        await new Promise((r) => setTimeout(r, 30))
        return { text: '', toolCalls: [{ id: `c${chamadas}`, name: 'run_sql', input: { sql: 'select 1' } }], raw: null }
      },
    }
    const r = await runAgent({ provider: p, system: 'S', messages: [], tools: [], maxRounds: 50, maxMs: 50,
      exec: async () => ({ content: '{"rowCount":1}' }) })
    assert.equal(r.text, 'Parcial.')
    assert.equal(r.limitReached, true)
    assert.ok(r.rounds < 50 && r.rounds >= 1, `rodadas: ${r.rounds}`)
    assert.equal(r.trace[0].sql, 'select 1')
  })
})

describe('avaliação: gabarito calculado na hora', () => {
  it('lê números em pt-BR (milhar, decimal, %, mil, milhões)', async () => {
    const { numerosDoTexto } = await import('../modules/ai/evaluation.js')
    const n = numerosDoTexto('São 87.788 contratos, ARPU de R$ 102,25, taxa de 2,35%, receita de R$ 4,57 milhões e 12 mil faturas; em inglês 1,234.5.')
    for (const esperado of [87788, 102.25, 2.35, 4_570_000, 12_000, 1234.5]) {
      assert.ok(n.some((x) => Math.abs(x - esperado) < 1e-6), `faltou ${esperado} em ${JSON.stringify(n)}`)
    }
  })

  it('confere número com tolerância e texto sem acento', async () => {
    const { confere } = await import('../modules/ai/evaluation.js')
    const r = confere('A maior é São Leopoldo, com 41,2 mil contratos e taxa de 1,9%.',
      { cidade: 'SAO LEOPOLDO', n: 41_180, taxa: 1.94 },
      [{ coluna: 'cidade', tipo: 'texto' }, { coluna: 'n', tipo: 'numero', tol: 0.005 }, { coluna: 'taxa', tipo: 'pct', tol: 0.06 }])
    assert.deepEqual(r.map((c) => c.ok), [true, true, true])
    const errado = confere('São 50.000 contratos.', { n: 87_788 }, [{ coluna: 'n', tipo: 'numero', tol: 0.005 }])
    assert.equal(errado[0].ok, false)
  })

  // Provedor falso que se comporta como um modelo honesto: consulta o SQL de
  // referência e responde com o número que voltou — ou com um número errado.
  function provedorQueResponde(certo: boolean): AIProvider {
    return {
      name: 'falso', model: 'falso', isConfigured: () => true, listModels: async () => [],
      toolResultMessage: (results) => ({ role: 'user', content: results }),
      async chat(_s: string, messages: AiMessage[]): Promise<AiTurn> {
        const ultimo = messages[messages.length - 1]
        if (Array.isArray(ultimo?.content)) {
          const j = JSON.parse((ultimo.content as { content: string }[])[0].content)
          const n = Number(j.linhas[0].contratos_ativos) + (certo ? 0 : 5_000)
          return { text: `Temos ${n.toLocaleString('pt-BR')} contratos ativos hoje.`, toolCalls: [], raw: null }
        }
        return {
          text: '', raw: null,
          toolCalls: [{ id: 'c1', name: 'run_sql', input: { sql: 'select contratos_ativos from ouro_base_ativa_mensal order by mes desc limit 1' } }],
        }
      },
    }
  }

  it('resposta certa passa, errada falha, conjunto ausente é pulado', async () => {
    const { CASOS, avaliaCaso } = await import('../modules/ai/evaluation.js')
    const caso = CASOS.find((c) => c.id === 'base-ativos-hoje')!
    const ok = await avaliaCaso(caso, usuario('admin'), provedorQueResponde(true))
    assert.equal(ok.status, 'ok', JSON.stringify(ok))
    assert.equal(ok.esperado?.contratos_ativos, 87788)
    const ruim = await avaliaCaso(caso, usuario('admin'), provedorQueResponde(false))
    assert.equal(ruim.status, 'falhou')
    const ausente = await avaliaCaso(CASOS.find((c) => c.id === 'canc-taxa-out')!, usuario('admin'), provedorQueResponde(true))
    assert.equal(ausente.status, 'pulado')
    assert.match(ausente.motivo ?? '', /ouro_cancelamento_mensal/)
  })

  it('a rota é de admin e lista as perguntas', async () => {
    assert.equal((await as('viewer').get('/api/v1/ai/eval')).status, 403)
    assert.equal((await as('viewer').post('/api/v1/ai/eval', {})).status, 403)
    const g = await as('admin').get('/api/v1/ai/eval')
    assert.equal(g.status, 200, JSON.stringify(g.body))
    const { CASOS } = await import('../modules/ai/evaluation.js')
    assert.equal(g.body.casos.length, CASOS.length)
    // Sem provedor cadastrado no teste: recusa em vez de rodar no vazio.
    assert.equal((await as('admin').post('/api/v1/ai/eval', {})).status, 503)
  })
})
