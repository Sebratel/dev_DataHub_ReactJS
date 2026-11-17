// ─────────────────────────────────────────────────────────────────────────
// Alerta do disco do lake (MON-03; canal decidido na R6, D-MON-3: Google Chat).
//
// O disco cheio para todas as cargas de uma vez, e até a R6 ele só aparecia no
// sino, para quem abrisse o Data Hub. Roda a cada 15 min pelo agendador.
//
// Avisa na TROCA de estado, como as verificações contínuas: passou do limite
// (SYNC_DISK_WARN_PERCENT, 85% por padrão) e voltou para baixo dele. O estado
// é o último alerta de disco registrado: assim sobrevive a um reinício da API
// sem reavisar o que já foi avisado.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { lakeDiskPercent } from '../../core/lake.js'
import { notify } from './notify.js'

export async function checkDiskAlert(pct: number | null = lakeDiskPercent()): Promise<void> {
  if (!isDbAvailable() || pct == null) return
  const limite = config.sync.diskWarnPercent
  const acima = pct >= limite
  for (const t of (await db.query(`select id from tenants`)).rows) {
    const tenantId = String(t.id)
    const ultimo = (await db.query(
      `select kind from alert_events where tenant_id = $1 and kind in ('disk-high', 'disk-ok')
        order by created_at desc limit 1`, [tenantId],
    )).rows[0]?.kind as string | undefined
    const avisadoAcima = ultimo === 'disk-high'
    if (acima && !avisadoAcima) {
      await notify(tenantId, {
        key: 'disk:high', kind: 'disk-high',
        title: `Disco do lake em ${pct}%`,
        lines: [
          `Acima do limite de aviso (${limite}%). Cargas grandes usam espaço temporário além disso.`,
          'Os maiores conjuntos estão em Operar › Padronizar atualização.',
        ],
      })
    } else if (!acima && avisadoAcima) {
      await notify(tenantId, {
        key: `disk:ok:${Date.now()}`, kind: 'disk-ok',
        title: `Disco do lake de volta a ${pct}%`,
        lines: [`Abaixo do limite de aviso (${limite}%).`],
      })
    }
  }
}
