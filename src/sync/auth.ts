import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
}

export interface AuthState {
  /** 'disabled' = Supabase not configured: the app runs local-only. */
  readonly status: 'disabled' | 'loading' | 'signed-out' | 'signed-in';
  readonly user: AuthUser | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly info: string | null;
}

/** Email + password auth (works inside installed PWAs, unlike redirect-based flows on iOS). */
export class AuthStore {
  private state: AuthState;
  private readonly listeners = new Set<() => void>();
  private readonly client: SupabaseClient | null;
  private unsubscribe: (() => void) | null = null;

  constructor(client: SupabaseClient | null) {
    this.client = client;
    this.state = { status: client ? 'loading' : 'disabled', user: null, busy: false, error: null, info: null };
    if (!client) return;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ? { id: session.user.id, email: session.user.email ?? null } : null;
      this.patch({ status: user ? 'signed-in' : 'signed-out', user });
    });
    this.unsubscribe = () => data.subscription.unsubscribe();
    void client.auth.getSession().then(({ data: s }) => {
      const user = s.session?.user ? { id: s.session.user.id, email: s.session.user.email ?? null } : null;
      this.patch({ status: user ? 'signed-in' : 'signed-out', user });
    });
  }

  getState = (): AuthState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async signIn(email: string, password: string): Promise<void> {
    await this.run(async (c) => {
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw error;
    });
  }

  async signUp(email: string, password: string): Promise<void> {
    await this.run(async (c) => {
      const { data, error } = await c.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) this.patch({ info: 'Account created. Confirm the email if your project requires it, then sign in.' });
    });
  }

  async signOut(): Promise<void> {
    await this.run(async (c) => {
      // 'local': only this device. The default ('global') would also end the sessions of the
      // user's other devices, which would then silently stop syncing.
      const { error } = await c.auth.signOut({ scope: 'local' });
      if (error) throw error;
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.listeners.clear();
  }

  private async run(fn: (c: SupabaseClient) => Promise<void>): Promise<void> {
    if (!this.client) return;
    this.patch({ busy: true, error: null, info: null });
    try {
      await fn(this.client);
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.patch({ busy: false });
    }
  }

  private patch(p: Partial<AuthState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}
