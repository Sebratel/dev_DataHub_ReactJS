// Smoke do aviso de carga das conexões. Roda sem banco e sem chave:
// `avisoDeConexoes` é decisão pura sobre (quantas existem, quantas carregaram,
// tem chave).
//
// Por que existe: em 18/10/2026 um redeploy deixou a CONNECTIONS_SECRET em
// branco na stack. O carregamento desistia num `return` sem log, a API subia
// saudável, o health check passava — e 20 conjuntos ficaram três dias sem
// atualizar, sem uma linha que dissesse por quê. Este aviso é o que faltava,
// e um aviso que não dispara na hora certa não serve para nada.
//
// Uso: npm run connboot:smoke --workspace apps/api
import { avisoDeConexoes } from '../connectors/store.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('\n── instalação nova: nada a avisar ──')
check('sem conexões e sem chave fica calado',
  avisoDeConexoes({ cadastradas: 0, carregadas: 0, temChave: false }) === null)
check('sem conexões e com chave também',
  avisoDeConexoes({ cadastradas: 0, carregadas: 0, temChave: true }) === null)

console.log('\n── tudo certo: também fica calado ──')
check('3 cadastradas, 3 carregadas',
  avisoDeConexoes({ cadastradas: 3, carregadas: 3, temChave: true }) === null)

// O caso do incidente, exatamente como aconteceu.
console.log('\n── a chave sumiu e há conexões cadastradas ──')
const semChave = avisoDeConexoes({ cadastradas: 3, carregadas: 0, temChave: false })
check('avisa', semChave !== null)
check('diz QUANTAS foram perdidas', !!semChave?.includes('3 conexão'))
check('nomeia a variável, para a busca no log achar', !!semChave?.includes('CONNECTIONS_SECRET'))
check('diz a consequência, não só o fato', !!semChave?.includes('vai falhar'))
check('diz o que fazer', !!semChave?.toLowerCase().includes('mesma chave'))

// O que o `:?` do compose NÃO pega: a chave está definida, mas é outra.
console.log('\n── a chave está definida, porém é outra (rotação) ──')
const outra = avisoDeConexoes({ cadastradas: 3, carregadas: 1, temChave: true })
check('avisa', outra !== null)
check('diz quantas de quantas', !!outra?.includes('2 de 3'))
check('aponta a causa certa: chave DIFERENTE, não ausente',
  !!outra?.includes('DIFERENTE') && !outra?.includes('AUSENTE'))

console.log('\n── uma só, para conferir o plural ──')
const uma = avisoDeConexoes({ cadastradas: 1, carregadas: 0, temChave: false })
check('conta certo com uma conexão', !!uma?.includes('1 conexão'))

console.log(`\n${failures ? `${failures} FALHA(S)` : 'tudo ok'}\n`)
process.exit(failures ? 1 : 0)
