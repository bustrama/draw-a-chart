/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy JWT anon key; used only if the publishable key is not set. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** 'true' shows "Create account" in the app (create your account once, then turn it off). */
  readonly VITE_ALLOW_SIGNUP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
