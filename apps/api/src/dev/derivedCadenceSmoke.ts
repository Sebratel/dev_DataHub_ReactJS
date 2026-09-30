// Smoke da auditoria de cadência dos conjuntos CALCULADOS. Roda sem banco:
// `auditDerivedCadence` é decisão pura sobre linhas do catálogo.
//
// Por que existe: a rota grava EM LOTE a partir deste parecer. Um falso
// positivo aqui não dá erro em lugar nenhum — ele coloca um calculado em
// cascata sem gatilho, e o conjunto simplesmente para de atualizar em
// silêncio, sem aparecer como atrasado nem falhando em tela nenhuma. É
// exatamente o tipo de defeito que só a leitura do código não pega, porque
// depende do casamento entre o SQL escrito à mão e os slugs do catálogo.
//
// Uso: npm run derived:smoke --workspace apps/api
import { auditDerivedCadence, type CadenceRow } from '../modules/transform/derive.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const fonte = (slug: string, name: string): CadenceRow =>
  ({ id: `s-${slug}`, slug, name, kind: 'source', cadence: 'hourly', transformSql: null })
const calc = (slug: string, cadence: string, sql: string | null): CadenceRow =>
  ({ id: `d-${slug}`, slug, name: slug.toUpperCase(), kind: 'derived', cadence, transformSql: sql })

const CATALOGO: CadenceRow[] = [
  fonte('financial-receivable-titles', 'Títulos a receber'),
  fonte('assignment', 'Assignment'),
  calc('receita-mensal', 'daily', 'select * from financial_receivable_titles'),
  calc('sla-bko', 'hourly', 'select * from "assignment" a join receita_mensal r on true'),
  calc('ja-em-cascata', 'cascade', 'select * from assignment'),
  calc('manual-de-proposito', 'manual', 'select * from assignment'),
  calc('sem-dependencia', 'daily', "select 1 as um, current_date as hoje"),
  calc('cascata-sem-gatilho', 'cascade', 'select 42 as resposta'),
  calc('no-agendamento', 'schedule', 'select * from assignment'),
]

const itens = auditDerivedCadence(CATALOGO)
const by = (slug: string) => itens.find((i) => i.slug === slug)!

console.log('\n── quem entra na auditoria ──')
check('só derivados são auditados', itens.length === 7, `${itens.length} itens`)
check('fonte não aparece', !itens.some((i) => i.slug === 'assignment'))

console.log('\n── elegíveis para cascata ──')
check('relógio diário citando uma fonte → elegível', by('receita-mensal').eligible === true)
check('relógio de hora em hora citando fonte e derivado → elegível', by('sla-bko').eligible === true)

console.log('\n── não elegíveis, e por quê ──')
for (const [slug, trecho] of [
  ['ja-em-cascata', 'Já recalcula'],
  ['manual-de-proposito', 'deliberada'],
  ['no-agendamento', 'agendamento em lote'],
  ['sem-dependencia', 'não cita nenhum outro conjunto'],
] as const) {
  const i = by(slug)
  check(`${slug} fica de fora`, i.eligible === false && !!i.reason?.includes(trecho),
    i.reason ?? 'sem motivo')
}

// O caso que a auditoria existe para achar: já está em cascata, e por isso
// some de qualquer lista de "precisa mudar" — mas nada o dispara.
console.log('\n── cascata sem gatilho (o achado silencioso) ──')
const orfao = by('cascata-sem-gatilho')
check('não é oferecido para troca', orfao.eligible === false)
check('não tem dependência', orfao.dependsOn.length === 0)
check('o motivo diz que não vai atualizar sozinho',
  !!orfao.reason?.includes('nada dispara'), orfao.reason ?? '')

console.log('\n── dependências resolvidas por NOME ──')
check('apelido com underscore é reconhecido',
  by('receita-mensal').dependsOn.join() === 'Títulos a receber',
  by('receita-mensal').dependsOn.join(', '))
check('slug entre aspas e apelido convivem no mesmo SQL',
  by('sla-bko').dependsOn.length === 2, by('sla-bko').dependsOn.join(', '))

// Um derivado que se cita (CTE com o próprio nome) não depende de si mesmo —
// senão ele apareceria como elegível sem ter gatilho externo nenhum.
console.log('\n── autorreferência não conta como dependência ──')
const auto = auditDerivedCadence([
  calc('resumo', 'daily', 'with resumo as (select 1) select * from resumo'),
])[0]
check('não lista a si mesmo', auto.dependsOn.length === 0, auto.dependsOn.join(', '))
check('e por isso não é oferecido para cascata', auto.eligible === false)

console.log(`\n${failures ? `${failures} FALHA(S)` : 'tudo ok'}\n`)
process.exit(failures ? 1 : 0)
