// ─────────────────────────────────────────────────────────────────────────
// Assistente IA — a ferramenta list_field_values, contra um lake de verdade.
//
// O caso que motivou: "quantos clientes passaram pelas tags desbloqueio de
// confiança e segunda via de boletos?". As tags estão gravadas como
// ISA_DESBLOQUEIO_CONFIANÇA (com Ç) e ISA_SEGUNDA_VIA_BOLETOS, várias numa
// célula só ("A || B"), e até 14/05/2026 com outro nome ("Desbloqueio de
// confiança"). O agente chutava a grafia, recebia zero linhas e garimpava
// conjuntos até o limite. Aqui o dado tem exatamente essa forma.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { shutdown, seedDataset, USERS } from './harness.js'

let executeTool: typeof import('../modules/ai/tools.js').executeTool
const usuario = (who: 'admin' | 'viewer') => ({
  email: USERS[who], name: who, roles: [who], tenant: 'sebratel', master: false, masterConfigured: true,
}) as never

async function valores(input: Record<string, unknown>, who: 'admin' | 'viewer' = 'admin') {
  const r = await executeTool('list_field_values', input, usuario(who))
  return { ...r, json: r.isError ? null : JSON.parse(r.content) }
}

before(async () => {
  ;({ executeTool } = await import('../modules/ai/tools.js'))
  await seedDataset({
    slug: 'atendimentos-matrix',
    fields: [
      { key: 'protocolo', type: 'number' },
      { key: 'tag' },
      { key: 'cpf', sensitive: true },
      { key: 'nota_interna', hidden: true },
    ],
    rowsSql: `select * from (values
      (1, '"ISA_DESBLOQUEIO_CONFIANÇA || ISA_GERAL_ENCERRAMENTO"', '11111111111', 'a'),
      (2, '"ISA_SEGUNDA_VIA_BOLETOS || ISA_GERAL_ENCERRAMENTO"', '22222222222', 'b'),
      (3, 'ISA_SEGUNDA_VIA_BOLETOS', '33333333333', 'c'),
      (4, 'Desbloqueio de confiança', '44444444444', 'd'),
      (5, '"ISA_DESBLOQUEIO_CONFIANÇA_ESGOTADO || ATENDIMENTO_HUMANO_FINANCEIRO"', '55555555555', 'e'),
      (6, '-', '66666666666', 'f')
    ) t(protocolo, tag, cpf, nota_interna)`,
  })
  await seedDataset({
    slug: 'privado-do-editor', visibility: 'private', owner: 'editor',
    fields: [{ key: 'tag' }],
    rowsSql: `select 'X' as tag`,
  })
})
after(shutdown)

describe('list_field_values: achar como o valor está gravado', () => {
  it('"desbloqueio de confiança" acha a tag com Ç, a esgotada e o nome antigo', async () => {
    const r = await valores({ dataset: 'atendimentos-matrix', field: 'tag', search: 'desbloqueio de confiança' })
    assert.equal(r.isError, undefined, r.content)
    assert.equal(r.json.separator, '||', 'a lista "A || B" é detectada sozinha')
    assert.deepEqual(r.json.values.map((v: any) => v.valor).sort(),
      ['Desbloqueio de confiança', 'ISA_DESBLOQUEIO_CONFIANÇA', 'ISA_DESBLOQUEIO_CONFIANÇA_ESGOTADO'])
  })

  it('a contagem é de linhas com a tag — a frequência que a pergunta quer', async () => {
    const r = await valores({ dataset: 'atendimentos-matrix', field: 'tag', search: 'segunda via boleto' })
    assert.deepEqual(r.json.values, [{ valor: 'ISA_SEGUNDA_VIA_BOLETOS', linhas: 2 }])
  })

  it('sem busca, os mais frequentes primeiro, já separados', async () => {
    const r = await valores({ dataset: 'atendimentos-matrix', field: 'tag' })
    assert.deepEqual(r.json.values.slice(0, 2).map((v: any) => [v.valor, v.linhas]),
      [['ISA_GERAL_ENCERRAMENTO', 2], ['ISA_SEGUNDA_VIA_BOLETOS', 2]])
    assert.ok(r.json.values.every((v: any) => !String(v.valor).includes('"')), 'as aspas do Matrix saem')
    assert.equal(r.json.distintos, 7)
  })

  it('busca que não acha nada devolve uma dica, não um silêncio', async () => {
    const r = await valores({ dataset: 'atendimentos-matrix', field: 'tag', search: 'portabilidade numerica' })
    assert.deepEqual(r.json.values, [])
    assert.match(r.json.dica, /palavra só/)
  })
})

describe('list_field_values: o que a IA não pode ver', () => {
  it('campo sensível é recusado, também para admin (SEG-05)', async () => {
    const r = await valores({ dataset: 'atendimentos-matrix', field: 'cpf' })
    assert.equal(r.isError, true)
    assert.match(r.content, /sensível/)
    assert.ok(!r.content.includes('111'), 'nenhum valor vaza na recusa')
  })

  it('campo oculto não existe para a IA', async () => {
    const r = await valores({ dataset: 'atendimentos-matrix', field: 'nota_interna' })
    assert.equal(r.isError, true)
    assert.match(r.content, /Campo não encontrado/)
  })

  it('conjunto que a pessoa não acessa não existe para a IA dela', async () => {
    const r = await valores({ dataset: 'privado-do-editor', field: 'tag' }, 'viewer')
    assert.equal(r.isError, true)
    assert.match(r.content, /Conjunto não encontrado/)
  })
})

describe('o rastro guarda o pedido, nunca o resultado', () => {
  it('detalhe e contagem saem do pedido e do total — sem nenhum valor devolvido', async () => {
    const { detalheDaTool, linhasDoResultado } = await import('../modules/ai/agent.js')
    const input = { dataset: 'atendimentos-matrix', field: 'tag', search: 'segunda via' }
    const out = await executeTool('list_field_values', input, usuario('admin'))
    assert.equal(detalheDaTool('list_field_values', input), 'campo tag · busca "segunda via"')
    assert.equal(linhasDoResultado('list_field_values', out), 1)
    const persistido = JSON.stringify({ detalhe: detalheDaTool('list_field_values', input), linhas: 1 })
    assert.ok(!persistido.includes('ISA_SEGUNDA_VIA_BOLETOS'), 'o valor devolvido não entra no rastro')
  })
})
