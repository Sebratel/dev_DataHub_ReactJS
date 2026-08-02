// Fase 3: executa os HEALTH CHECKS vencidos — pinga cada endpoint e registra a
// latência/status em api_call_metrics (check_type='healthcheck'), então o
// resultado aparece no mesmo painel "Saúde das APIs". Reaproveita a auth de uma
// conexão HTTP quando informada. Chamado por um tick a cada 60s.
import { db, isDbAvailable } from '../db/pool.js'
import { getConnector } from './registry.js'
import { testHttp } from './httpSource.js'

export async function runDueHealthChecks(): Promise<void> {
  if (!isDbAvailable()) return
  try {
    const due = (await db.query(
      `select id, name, url, connection_id from health_checks
        where enabled
          and (last_run_at is null or last_run_at < now() - make_interval(mins => interval_minutes))`,
    )).rows
    for (const c of due) {
      const conn = c.connection_id ? getConnector(String(c.connection_id)) : undefined
      const auth = conn?.kind === 'http' && conn.http
        ? { header: conn.http.authHeader, scheme: conn.http.authScheme, token: conn.http.token }
        : undefined
      const r = await testHttp(String(c.url), auth, 10_000)
      // "no ar" = respondeu E status < 400. Rede caiu (r.ok=false) → fora.
      const up = r.ok && r.status != null && r.status < 400
      const error = !r.ok ? (r.error ?? 'falha de rede') : (r.status && r.status >= 400 ? `HTTP ${r.status}` : null)
      await db.query(
        `insert into api_call_metrics (dataset_slug, connection_id, endpoint, status, ok, duration_ms, error, check_type)
         values ($1, $2, $3, $4, $5, $6, $7, 'healthcheck')`,
        [c.name, c.connection_id ?? null, c.url, r.status ?? null, up, r.latencyMs, error],
      )
      await db.query('update health_checks set last_run_at = now() where id = $1', [c.id])
    }
    if (due.length) console.log(`[healthcheck] ${due.length} verificação(ões) executada(s).`)
  } catch (e) {
    console.warn(`[healthcheck] tick falhou: ${(e as Error).message}`)
  }
}
