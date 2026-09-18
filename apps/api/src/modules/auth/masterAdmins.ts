// ─────────────────────────────────────────────────────────────────────────
// Quem é admin master, das DUAS origens.
//
//   AMBIENTE (MASTER_ADMIN_EMAILS, herdando ADMIN_EMAILS) — raiz de confiança.
//     Não editável pela tela, nunca. É o caminho de recuperação quando a lista
//     do banco fica errada (revogação demais, conta comprometida).
//   BANCO (master_admins) — delegação, concedida por outro master pela tela.
//
// Efetivo = união das duas. A checagem é contra um Set em memória, recarregado
// no boot e a cada mutação — o mesmo padrão das conexões e dos upstreams. Uma
// consulta ao banco por requisição autenticada seria desperdício: isto é lido
// em todo request e muda algumas vezes por ano.
// ─────────────────────────────────────────────────────────────────────────
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'

// Só os concedidos pela tela. Os do ambiente ficam em config e nunca entram
// aqui — misturar os dois tiraria a capacidade de dizer "este não dá para
// remover", que é o que protege o caminho de recuperação.
let granted = new Set<string>()

const norm = (e: string) => e.trim().toLowerCase()

export async function reloadMasterAdmins(): Promise<void> {
  if (!isDbAvailable()) { granted = new Set(); return }
  const rows = (await db.query(`select email from master_admins`)).rows
  granted = new Set(rows.map((r) => norm(String(r.email))))
}

/** É master? Vale para as duas origens. */
export function isMaster(email: string): boolean {
  const e = norm(email)
  return config.masterAdminEmails.includes(e) || granted.has(e)
}

/** Veio do ambiente — a tela não pode remover. */
export function isEnvMaster(email: string): boolean {
  return config.masterAdminEmails.includes(norm(email))
}

export interface MasterEntry {
  email: string
  /** 'env' = fixo no servidor, não removível pela tela; 'granted' = concedido. */
  origin: 'env' | 'granted'
  grantedBy: string | null
  note: string
  createdAt: string | null
}

export async function listMasterAdmins(): Promise<MasterEntry[]> {
  const rows = isDbAvailable()
    ? (await db.query(`select email, granted_by, note, created_at from master_admins order by email`)).rows
    : []
  const doAmbiente: MasterEntry[] = config.masterAdminEmails.map((email) => ({
    email, origin: 'env', grantedBy: null, note: '', createdAt: null,
  }))
  const doBanco: MasterEntry[] = rows
    // Um e-mail que está nas duas origens aparece UMA vez, como 'env': é o que
    // manda (não dá para remover), e mostrar duas linhas do mesmo e-mail com
    // botões diferentes seria só confusão.
    .filter((r) => !isEnvMaster(String(r.email)))
    .map((r) => ({
      email: String(r.email), origin: 'granted' as const,
      grantedBy: String(r.granted_by), note: String(r.note ?? ''),
      createdAt: new Date(r.created_at as string).toISOString(),
    }))
  return [...doAmbiente, ...doBanco]
}

export async function grantMaster(email: string, by: string, note = ''): Promise<void> {
  const e = norm(email)
  if (!e.endsWith('@' + config.allowedDomain)) {
    throw new Error(`O e-mail precisa ser do domínio @${config.allowedDomain}.`)
  }
  if (isEnvMaster(e)) throw new Error('Este e-mail já é master pelo ambiente do servidor.')
  await db.query(
    `insert into master_admins (email, granted_by, note) values ($1, $2, $3)
     on conflict (email) do update set granted_by = excluded.granted_by, note = excluded.note`,
    [e, by, note],
  )
  await reloadMasterAdmins()
}

export async function revokeMaster(email: string, by: string): Promise<void> {
  const e = norm(email)
  // O do ambiente é a rede de segurança: se a tela pudesse removê-lo, um erro
  // (ou alguém mal-intencionado com acesso master) deixaria o hub sem ninguém
  // capaz de configurar as fontes, e sem caminho de volta que não fosse deploy.
  if (isEnvMaster(e)) {
    throw new Error(
      'Este master vem de MASTER_ADMIN_EMAILS, no ambiente do servidor, e existe justamente como ' +
      'caminho de recuperação. Para removê-lo, altere a variável na stack e faça o redeploy.',
    )
  }
  if (e === norm(by)) {
    // Bloquear a auto-remoção evita o engano mais comum e não fecha porta
    // nenhuma: qualquer outro master (o do ambiente, sempre presente) faz.
    throw new Error('Você não pode remover o seu próprio acesso master — peça a outro master.')
  }
  const r = await db.query(`delete from master_admins where email = $1`, [e])
  if (!r.rowCount) throw new Error('Este e-mail não é um master concedido pela tela.')
  await reloadMasterAdmins()
}
