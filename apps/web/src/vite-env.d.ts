/// <reference types="vite/client" />

interface Window {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient: (cfg: unknown) => { requestAccessToken: (opts?: { prompt?: string }) => void }
      }
    }
  }
}
