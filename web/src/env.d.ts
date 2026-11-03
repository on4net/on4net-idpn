interface ImportMetaEnv extends Record<string, string | undefined> {
  /** Public base URL of the IdP; mirrors `APP_URL` for the browser build. */
  readonly VITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
