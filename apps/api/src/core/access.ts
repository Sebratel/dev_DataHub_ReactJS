// ─────────────────────────────────────────────────────────────────────────
// Controle de acesso a conjuntos de dados (Sprint 8). FONTE ÚNICA DA VERDADE —
// query, export, catálogo e IA chamam SÓ estas funções, para a regra viver num
// lugar só. Regra: admin vê tudo; dono vê o próprio; visibility='tenant' é
// aberto a todo o tenant; senão, precisa de concessão (dataset_grants) por
// e-mail ou por time do qual o usuário é membro.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../db/pool.js'

export interface AccessUser {
  email: string
  tenant: string
  roles: string[]
}

function isAdmin(u: AccessUser): boolean {
  return u.roles.includes('admin')
}

// Condição SQL reutilizável: "o usuário $email pode LER o dataset d". Presume
// que a query tenha `datasets d` no FROM. Não cobre admin (checar antes).
const READ_PREDICATE = `(
  d.visibility = 'tenant'
  or d.owner_email = $EMAIL
  or exists (select 1 from dataset_grants g
              where g.dataset_id = d.id and g.grantee_email = $EMAIL)
  or exists (select 1 from dataset_grants g
               join team_members m on m.team_id = g.team_id
              where g.dataset_id = d.id and m.user_email = $EMAIL)
)`

// Ids de datasets que o usuário pode LER, dentro do seu tenant. Usado para
// filtrar a listagem do catálogo (e o que a IA enxerga).
export async function accessibleDatasetIds(user: AccessUser): Promise<Set<string>> {
  const rows = (await db.query(
    `select d.id from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and ($2 or ${READ_PREDICATE.replace(/\$EMAIL/g, '$3')})`,
    [user.tenant, isAdmin(user), user.email],
  )).rows
  return new Set(rows.map((r) => String(r.id)))
}

// O usuário pode LER este dataset (por id)?
export async function canQuery(user: AccessUser, datasetId: string): Promise<boolean> {
  if (isAdmin(user)) return true
  const r = await db.query(
    `select 1 from datasets d
      where d.id = $1 and ${READ_PREDICATE.replace(/\$EMAIL/g, '$2')} limit 1`,
    [datasetId, user.email],
  )
  return (r.rowCount ?? 0) > 0
}

// O usuário pode EXPORTAR este dataset? Admin/dono sempre; conjunto aberto ao
// tenant é exportável por quem lê; por concessão, respeita o flag can_export.
export async function canExport(user: AccessUser, datasetId: string): Promise<boolean> {
  if (isAdmin(user)) return true
  const r = (await db.query(
    `select
       bool_or(d.owner_email = $2)            as owner,
       bool_or(d.visibility = 'tenant')       as tenant_open,
       coalesce(bool_or(g.can_export), false) as granted_export
     from datasets d
     left join dataset_grants g on g.dataset_id = d.id and (
        g.grantee_email = $2
        or g.team_id in (select team_id from team_members where user_email = $2))
     where d.id = $1`,
    [datasetId, user.email],
  )).rows[0]
  if (!r || r.owner == null) return false // dataset inexistente
  return !!r.owner || !!r.tenant_open || !!r.granted_export
}
