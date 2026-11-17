// ─────────────────────────────────────────────────────────────────────────
// Erro em rota async vira resposta, e não requisição pendurada (DSP-18).
//
// O Express 4 só encaminha ao middleware de erro o que o handler LANÇA de
// forma síncrona. A rejeição de um handler async (um id inválido que o banco
// recusa, por exemplo) escapava: ninguém respondia, e a requisição ficava
// aberta até o tempo limite do nginx. O `unhandledRejection` do index.ts só
// evitava que a API caísse junto.
//
// A correção é a do pacote express-async-errors, sem a dependência: o Layer
// passa a encaminhar a promessa rejeitada para o next(err). Vale para toda
// rota e todo middleware, inclusive os montados depois, sem mexer em nenhum
// handler — o perms:smoke continua lendo a mesma pilha.
// ─────────────────────────────────────────────────────────────────────────
import type { NextFunction, Request, Response } from 'express'
import Layer from 'express/lib/router/layer.js'

let instalado = false

export function encaminharErrosAsync(): void {
  if (instalado) return
  instalado = true
  Layer.prototype.handle_request = function handle(req: Request, res: Response, next: NextFunction) {
    const fn = this.handle
    if (fn.length > 3) return next() // middleware de erro: não é a vez dele
    try {
      const r = fn(req, res, next) as unknown
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        // Rejeição sem motivo (reject()) também é erro: next(undefined) seguiria adiante.
        ;(r as Promise<unknown>).catch((e: unknown) => next(e ?? new Error('Rejeição sem motivo.')))
      }
    } catch (e) {
      next(e)
    }
  }
}

/** Último middleware: o erro vira JSON, sem expor SQL nem pilha. */
export function respostaDeErro(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = err as { code?: string; status?: number; statusCode?: number; expose?: boolean; message?: string }
  // Resposta já começou (ou terminou): só registra. Chamar o tratador padrão
  // derrubaria o socket de uma resposta que já foi entregue.
  if (res.headersSent) {
    console.error(`[api] erro depois da resposta em ${req.method} ${req.originalUrl}:`, err)
    if (!res.writableEnded) res.end()
    return
  }
  // Valor mal formado vindo da requisição (uuid ou data inválidos): 22P02 e
  // 22007 no Postgres; o cliente MariaDB traduz o 1366 e o 1292 para os mesmos.
  if (e?.code === '22P02' || e?.code === '22007') {
    res.status(400).json({ error: 'Valor inválido: confira o identificador ou a data enviada.' })
    return
  }
  // Erros do próprio Express (JSON mal formado, corpo grande demais).
  const status = e?.status ?? e?.statusCode
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: e.expose && e.message ? e.message : 'Requisição inválida.' })
    return
  }
  console.error(`[api] erro em ${req.method} ${req.originalUrl}:`, err)
  res.status(500).json({ error: 'Erro interno. O detalhe ficou no log da API.' })
}
