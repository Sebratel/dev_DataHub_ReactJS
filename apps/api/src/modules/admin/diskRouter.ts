// ─────────────────────────────────────────────────────────────────────────
// Uso de disco do volume do lake.
//
//   GET /api/v1/disk   (admin)
//
// Existe porque a única forma de investigar um "dente de serra" no disco era
// abrir o Grafana e correlacionar na mão com o log de auditoria — e só depois
// que o pico já tinha passado de 90%. O hub é dono do volume: ele sabe
// responder quanto ocupa, o que ocupa e quanto falta, sem sair da tela.
//
// O alerta também vive aqui: acima do teto, a resposta traz `alert` preenchido
// e a tela mostra. O teto é configurável porque a folga saudável depende do
// tamanho do volume — 85% num disco de 1 TB é outra história que 85% num de 50 GB.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import { diskUsage } from '../../core/lake.js'
import { config } from '../../core/config.js'
import { requireAuth } from '../auth/middleware.js'
import { pendingSyncs } from '../sync/ingest.js'

export const diskRouter = Router()

diskRouter.get('/', requireAuth({ role: 'admin' }), (_req, res) => {
  const uso = diskUsage()
  const teto = config.sync.diskWarnPercent

  // A mensagem muda conforme o que está acontecendo: com carga na fila, o
  // pico ainda vai subir, e essa é a informação que muda a decisão de quem
  // está prestes a enfileirar mais vinte recargas.
  let alert: string | null = null
  if (uso.usedPercent >= teto) {
    const naFila = pendingSyncs().length
    alert =
      `Disco em ${uso.usedPercent}% (limite de aviso: ${teto}%). ` +
      (naFila > 0
        ? `Há ${naFila} sincronização(ões) na fila — cada carga ocupa espaço temporário além do que já está em uso, ` +
          'então o pico ainda vai subir. Considere esvaziar a espera antes de continuar.'
        : 'Nenhuma carga na fila agora, então este é o uso em repouso — é o próprio lake que está grande.')
  }

  res.json({ ...uso, warnPercent: teto, alert })
})
