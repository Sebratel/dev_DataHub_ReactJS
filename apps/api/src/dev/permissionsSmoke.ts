// Smoke de PERMISSÃO das rotas que mexem em como as fontes atualizam.
//
// A regra é simples de dizer e fácil de perder: mudar a regra de atualização
// de um conjunto de FONTE é do admin MASTER; conjunto calculado segue com
// admin/editor. O jeito de perdê-la é banal — alguém acrescenta uma rota nova
// ao lado das existentes, copia o `...adminOnly` do vizinho e pronto: o buraco
// não aparece em lugar nenhum até alguém usá-lo.
//
// Este smoke lê a pilha de middlewares que o Express realmente montou e a
// compara com uma tabela explícita. Rota nova sem nível declarado FALHA — o
// que obriga quem a criou a decidir qual é o nível dela, em vez de herdar um
// por descuido.
//
// Uso: npm run perms:smoke --workspace apps/api
import { syncRouter } from '../modules/sync/syncRouter.js'
import { autotuneRouter } from '../modules/sync/autotuneRouter.js'
import { schedulesRouter } from '../modules/sync/schedulesRouter.js'
import { accessRouter, ROLES } from '../modules/admin/accessRouter.js'
import { isMaster, isEnvMaster, grantMaster, revokeMaster } from '../modules/auth/masterAdmins.js'
import { config } from '../core/config.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── Leitura da pilha montada pelo Express ────────────────────────────────
interface HandlerLayer { name: string }
interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: HandlerLayer[] }
}

/** 'PATCH /:id/sync-config' -> nomes dos middlewares, na ordem. */
function routesOf(router: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const stack = (router as { stack: RouteLayer[] }).stack ?? []
  for (const layer of stack) {
    if (!layer.route) continue
    const method = Object.keys(layer.route.methods)[0]?.toUpperCase() ?? '?'
    out.set(`${method} ${layer.route.path}`, layer.route.stack.map((h) => h.name))
  }
  return out
}

// ── A tabela: o que CADA rota exige ──────────────────────────────────────
// 'master'       → requireAuth:master (incondicional)
// 'master-src'   → requireAuth:admin + requireMasterOnSource
// 'master-sched' → requireAuth:admin + requireMasterOnScheduleMembers
// 'master-batch' → requireAuth:admin + requireMasterOnDatasetBatch
// 'admin'        → requireAuth:admin, sem trava extra (leitura ou operação)
//
// Os três "master-*" só exigem master QUANDO há conjunto de fonte envolvido —
// é o que mantém os calculados liberados, como sempre foram.
type Level = 'master' | 'master-src' | 'master-sched' | 'master-batch' | 'admin'

// Nome do middleware que cada nível condicional exige na pilha.
const GUARD: Partial<Record<Level, string>> = {
  'master-src': 'requireMasterOnSource',
  'master-sched': 'requireMasterOnScheduleMembers',
  'master-batch': 'requireMasterOnDatasetBatch',
}

const EXPECTED: Record<string, Record<string, Level>> = {
  syncRouter: {
    // A regra de atualização em si: o coração da restrição.
    'PATCH /:id/sync-config': 'master-src',
    // Operação, não configuração: tirar isto do time de operação impediria
    // reexecutar à mão uma carga que falhou de madrugada.
    'POST /:id/sync': 'admin',
    'POST /:id/sync-cancel': 'admin',
    'GET /:id/sync-runs': 'admin',
  },
  autotuneRouter: {
    // Diagnóstico é leitura pura do catálogo — não muda nada.
    'GET /auto-incremental': 'admin',
    'GET /:id/auto-incremental': 'admin',
    // Aplicar grava a regra em conjuntos de FONTE (planAll exclui calculados).
    'POST /auto-incremental/apply': 'master',
    // Reconciliar apaga/cria campo e pode zerar a configuração de sync.
    'POST /:id/reconcile-fields': 'master-src',
    // Recarga completa: zera o watermark e relê a fonte inteira.
    'POST /:id/reload': 'master-src',
  },
  // Só as rotas de MASTER do accessRouter entram na tabela: as demais (times,
  // concessões, auditoria) são de admin e têm guard próprio por rota, fora do
  // escopo desta verificação. Por isso este router é o único com `parcial`.
  accessRouter: {
    'GET /masters': 'master',
    'POST /masters': 'master',
    'DELETE /masters/:email': 'master',
  },
  schedulesRouter: {
    'GET /': 'admin',
    // Criar um agendamento não muda nada sozinho: nada o segue ainda.
    'POST /': 'admin',
    // Estas quatro mudam a cadência de quem já segue o agendamento.
    'PATCH /:id': 'master-sched',
    'DELETE /:id': 'master-sched',
    'POST /:id/assign': 'master-batch',
    'POST /unassign': 'master-batch',
  },
}

const ROUTERS: Record<string, unknown> = { syncRouter, autotuneRouter, schedulesRouter, accessRouter }

console.log('\n── nível de permissão por rota ──')
for (const [routerName, expected] of Object.entries(EXPECTED)) {
  const actual = routesOf(ROUTERS[routerName])

  // 1. Nenhuma rota pode existir sem estar na tabela — é o que pega a rota
  //    nova que alguém acrescentou copiando o guard do vizinho. O accessRouter
  //    fica de fora desta exigência: ele tem dezenas de rotas de admin que não
  //    são assunto deste smoke.
  for (const key of actual.keys()) {
    if (routerName !== 'accessRouter' && !(key in expected)) {
      check(`${routerName}: ${key} declarada`, false,
        'rota sem nível declarado neste smoke — decida o nível dela e registre aqui')
    }
  }

  for (const [key, level] of Object.entries(expected)) {
    const handlers = actual.get(key)
    if (!handlers) {
      check(`${routerName}: ${key}`, false, 'rota não encontrada (foi renomeada ou removida?)')
      continue
    }
    const temMaster = handlers.includes('requireAuth:master')
    const temAdmin = handlers.includes('requireAuth:admin')
    const guardEsperado = GUARD[level]
    // Nenhum guard condicional pode sobrar numa rota que não o declarou.
    const guardsPresentes = Object.values(GUARD).filter((g) => handlers.includes(g))

    if (level === 'master') {
      check(`${routerName}: ${key} exige master`, temMaster && !guardsPresentes.length, handlers.join(' → '))
    } else if (guardEsperado) {
      check(`${routerName}: ${key} exige master quando há fonte`,
        temAdmin && guardsPresentes.length === 1 && handlers.includes(guardEsperado),
        handlers.join(' → '))
    } else {
      check(`${routerName}: ${key} segue com admin`,
        temAdmin && !temMaster && !guardsPresentes.length, handlers.join(' → '))
    }
  }
}

// ── A lista de masters vem do AMBIENTE, nunca do banco ───────────────────
// É a propriedade que faz a restrição valer: o papel 'admin' mora no banco e
// QUALQUER admin pode conceder 'admin' a si mesmo pela tela de acessos. Se o
// master viesse de lá, a trava não travaria nada.
console.log('\n── origem da lista de masters ──')
check('masterAdminEmails sai de MASTER_ADMIN_EMAILS ou ADMIN_EMAILS',
  Array.isArray(config.masterAdminEmails))
check('a lista não está vazia nesta configuração',
  config.masterAdminEmails.length > 0,
  config.masterAdminEmails.join(', ') || 'VAZIA — ninguém poderá configurar as fontes')

// Um e-mail com papel 'admin' no banco não vira master por causa disso: o
// único caminho é estar na lista do ambiente. Conferido aqui de forma direta.
const forasteiro = 'qualquer.admin@sebratel.com.br'
check('um admin fora da lista não é master', !isMaster(forasteiro))
check('quem está no ambiente é master', isMaster(config.masterAdminEmails[0] ?? forasteiro))

// ── A porta que NÃO pode abrir ───────────────────────────────────────────
// PATCH /users/:email/role e operada por QUALQUER admin. Se 'master' virasse
// uma opcao ali, qualquer admin se concederia master e a trava das fontes
// deixaria de significar alguma coisa. Este e o teste mais importante do
// arquivo: ele guarda a unica propriedade que sustenta todo o resto.
console.log('\n── o papel master não pode ser auto-concedível ──')
check("'master' fora do seletor de papéis que qualquer admin opera",
  !(ROLES as readonly string[]).includes('master'), `ROLES = ${ROLES.join(', ')}`)

// ── Regras de concessão e revogação ──────────────────────────────────────
// As quatro recusas abaixo acontecem ANTES de qualquer acesso ao banco, então
// rodam aqui sem Postgres.
console.log('\n── regras de concessão e revogação ──')
const envMaster = config.masterAdminEmails[0] ?? 'dono@sebratel.com.br'

async function recusa(nome: string, fn: () => Promise<unknown>, trecho: string): Promise<void> {
  try {
    await fn()
    check(nome, false, 'deveria ter recusado, mas passou')
  } catch (e) {
    const msg = (e as Error).message
    check(nome, msg.includes(trecho), msg)
  }
}

await recusa('master do ambiente não pode ser removido pela tela',
  () => revokeMaster(envMaster, 'outro@sebratel.com.br'), 'caminho de recuperação')
await recusa('ninguém remove o próprio acesso master',
  () => revokeMaster('delegado@sebratel.com.br', 'delegado@sebratel.com.br'), 'seu próprio acesso')
await recusa('e-mail de fora do domínio não vira master',
  () => grantMaster('alguem@gmail.com', envMaster), 'domínio')
await recusa('conceder a quem já é master pelo ambiente é recusado',
  () => grantMaster(envMaster, envMaster), 'já é master pelo ambiente')

check('isEnvMaster distingue a origem', isEnvMaster(envMaster) && !isEnvMaster('delegado@sebratel.com.br'))

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
