// Smoke da posição na fila de sincronização. Roda sem banco: `queueStateOf` é
// decisão pura sobre (conjunto, quem espera, quem roda).
//
// Por que existe: este cálculo decide se o botão "Sincronizar agora" fica
// habilitado. Errar para o lado frouxo devolve o defeito que ele veio
// consertar — a pessoa clica de novo e enfileira o mesmo conjunto; errar para
// o lado apertado trava o botão de um conjunto que não está na fila nenhuma.
//
// Uso: npm run queue:smoke --workspace apps/api
import { queueStateOf } from '../modules/sync/ingest.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('\n── fila vazia ──')
let s = queueStateOf('a', [], null)
check('conjunto fora da fila fica ocioso', s.state === 'idle')
check('sem posição', s.position === null)
check('nada esperando', s.waiting === 0)
check('nada rodando', s.busy === false)

console.log('\n── é este que está rodando ──')
s = queueStateOf('a', [], 'a')
check('estado é "running"', s.state === 'running')
check('quem roda não tem posição de espera', s.position === null)
check('a plataforma está ocupada', s.busy === true)

console.log('\n── esperando atrás de outros ──')
s = queueStateOf('c', ['b', 'c', 'd'], 'a')
check('estado é "queued"', s.state === 'queued')
check('posição é 1-based, não índice', s.position === 2, `veio ${s.position}`)
check('conta a fila inteira, não só daqui para trás', s.waiting === 3)
check('sabe que há carga em andamento', s.busy === true)

console.log('\n── é o próximo ──')
s = queueStateOf('b', ['b', 'c'], 'a')
check('primeiro da espera', s.position === 1)

// Caso real: alguém pede carga com a plataforma ociosa. O conjunto entra na
// fila e começa logo em seguida — mas entre o push e o start existe um
// instante em que ele ESPERA sem nada rodando. O botão tem de travar aí
// também, senão o segundo clique cabe exatamente nessa fresta.
console.log('\n── espera sem nada rodando (a fresta entre entrar e começar) ──')
s = queueStateOf('a', ['a'], null)
check('ainda conta como "queued"', s.state === 'queued')
check('é o próximo', s.position === 1)
check('mas a plataforma não está ocupada', s.busy === false)

console.log('\n── outro conjunto roda, este nem está na fila ──')
s = queueStateOf('z', ['b', 'c'], 'a')
check('segue ocioso', s.state === 'idle' && s.position === null)
check('mesmo assim vê que há 2 esperando', s.waiting === 2)
check('e que algo roda', s.busy === true)

// Não deveria acontecer (enqueueSync recusa), mas se acontecesse o certo é
// "running" ganhar: é o estado mais restritivo, e o botão precisa travar.
console.log('\n── defensivo: rodando E na lista de espera ──')
s = queueStateOf('a', ['a'], 'a')
check('"running" vence "queued"', s.state === 'running')

console.log(`\n${failures ? `${failures} FALHA(S)` : 'tudo ok'}\n`)
process.exit(failures ? 1 : 0)
