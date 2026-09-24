/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Sync server, fixed at build time. Unset or '' = the origin that serves the app (the
   * self-hosted server serves both); 'off' = no sync (drawings stay on the device); otherwise the
   * server's URL, e.g. 'https://chart.example.com'.
   */
  readonly VITE_SYNC_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
