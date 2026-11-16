// Módulo interno do Express 4, sem tipos publicados. Usado só em core/asyncRoutes.ts.
declare module 'express/lib/router/layer.js' {
  import type { NextFunction, Request, Response } from 'express'
  interface LayerInstance {
    handle: (...args: unknown[]) => unknown
  }
  const Layer: {
    prototype: LayerInstance & {
      handle_request(this: LayerInstance, req: Request, res: Response, next: NextFunction): void
    }
  }
  export default Layer
}
