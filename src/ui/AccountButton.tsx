import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { AuthState, AuthStore } from '../sync/auth';
import type { SyncEngine, SyncState, SyncStatus } from '../sync/SyncEngine';
import { UserIcon } from './icons';
import { Popover } from './Popover';

interface Props {
  readonly auth: AuthStore | null;
  readonly sync: SyncEngine | null;
}

const LOCAL_ONLY: SyncStatus = { state: 'local-only', pending: 0, error: null, lastSyncedAt: null };
const NO_AUTH: AuthState = { status: 'disabled', user: null, busy: false, error: null, info: null };
const noop = () => () => undefined;

const STATE_STYLE: Record<SyncState, { dot: string; label: string }> = {
  'local-only': { dot: 'bg-ink-400', label: 'Saved on this device' },
  'signed-out': { dot: 'bg-ink-400', label: 'Signed out — saved on this device' },
  connecting: { dot: 'bg-amber-400', label: 'Connecting…' },
  syncing: { dot: 'bg-accent animate-pulse', label: 'Syncing…' },
  synced: { dot: 'bg-up', label: 'Synced' },
  offline: { dot: 'bg-amber-400', label: 'Offline — changes queued' },
  error: { dot: 'bg-down', label: 'Sync error — retrying' },
};

export function AccountButton({ auth, sync }: Props) {
  const [open, setOpen] = useState(false);
  const status = useSyncExternalStore(sync?.subscribe ?? noop, sync?.getStatus ?? (() => LOCAL_ONLY));
  const authState = useSyncExternalStore(auth?.subscribe ?? noop, auth?.getState ?? (() => NO_AUTH));
  const style = STATE_STYLE[status.state];
  // Local-only mode keeps a queue for a future sign-in; that is not something to flag.
  const showPending = status.pending > 0 && status.state !== 'local-only';
  return (
    <div className="relative">
      <button
        type="button"
        title={`${style.label}${showPending ? ` (${status.pending} pending)` : ''}`}
        aria-label="Account and sync"
        onClick={() => setOpen((o) => !o)}
        data-testid="account-button"
        data-sync-state={status.state}
        className={`ui-control relative flex h-8 items-center gap-1.5 rounded-md px-2 ${open ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'}`}
      >
        <UserIcon width={18} height={18} />
        <span className={`inline-block h-2 w-2 rounded-full ${style.dot}`} />
        {showPending && <span className="text-[11px] tabular-nums" data-testid="pending-count">{status.pending}</span>}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="w-72" testId="account-panel">
          <SyncSummary status={status} />
          <div className="mt-3 border-t border-ink-700 pt-3">
            {authState.status === 'disabled' ? (
              <p className="text-xs leading-relaxed text-ink-300">
                Cloud sync is not configured. Drawings are stored on this device. Set <code className="text-ink-100">VITE_SUPABASE_URL</code> and{' '}
                <code className="text-ink-100">VITE_SUPABASE_PUBLISHABLE_KEY</code> to sync across devices (see README).
              </p>
            ) : authState.status === 'signed-in' ? (
              <SignedIn auth={auth} state={authState} sync={sync} />
            ) : authState.status === 'loading' ? (
              <p className="text-xs text-ink-300">Checking session…</p>
            ) : (
              <SignInForm auth={auth} state={authState} />
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}

function pendingText(status: SyncStatus): string {
  const n = status.pending;
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (status.state === 'local-only') return 'Stored in this browser (IndexedDB)';
  if (status.state === 'signed-out') return n > 0 ? `${changes} will sync after you sign in` : 'Sign in to sync across devices';
  return n > 0 ? `${changes} waiting to sync` : 'No pending changes';
}

function SyncSummary({ status }: { status: SyncStatus }) {
  const style = STATE_STYLE[status.state];
  return (
    <div className="flex items-start gap-2" data-testid="sync-summary">
      <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
      <div className="min-w-0">
        <p className="font-medium text-ink-100">{style.label}</p>
        <p className="text-xs text-ink-400">
          {pendingText(status)}
          {status.lastSyncedAt ? ` · last sync ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : ''}
        </p>
        {status.error && <p className="mt-1 text-xs break-words text-down">{status.error}</p>}
      </div>
    </div>
  );
}

function SignedIn({ auth, state, sync }: { auth: AuthStore | null; state: AuthState; sync: SyncEngine | null }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="truncate text-xs text-ink-300">
        Signed in as <span className="text-ink-100">{state.user?.email ?? state.user?.id}</span>
      </p>
      <div className="flex gap-2">
        <button type="button" className="ui-control h-9 flex-1 rounded-lg bg-ink-700 text-ink-100 hover:bg-ink-600" onClick={() => void sync?.syncNow()}>
          Sync now
        </button>
        <button type="button" className="ui-control h-9 flex-1 rounded-lg bg-ink-800 text-ink-200 hover:bg-ink-700" disabled={state.busy} onClick={() => void auth?.signOut()}>
          Sign out
        </button>
      </div>
      {state.error && <p className="text-xs text-down">{state.error}</p>}
    </div>
  );
}

const ALLOW_SIGNUP = import.meta.env.VITE_ALLOW_SIGNUP === 'true';

function SignInForm({ auth, state }: { auth: AuthStore | null; state: AuthState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!auth) return;
    void (mode === 'sign-in' ? auth.signIn(email, password) : auth.signUp(email, password));
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-testid="sign-in-form">
      <p className="text-xs text-ink-300">Sign in to sync drawings across your devices.</p>
      <input
        type="email"
        required
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="h-9 rounded-lg border border-ink-700 bg-ink-900 px-2.5 text-ink-100 outline-none focus:border-accent"
      />
      <input
        type="password"
        required
        minLength={8}
        autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-9 rounded-lg border border-ink-700 bg-ink-900 px-2.5 text-ink-100 outline-none focus:border-accent"
      />
      <button type="submit" disabled={state.busy} className="ui-control h-9 rounded-lg bg-accent font-medium text-ink-950 disabled:opacity-50">
        {state.busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
      </button>
      {ALLOW_SIGNUP && (
        <button type="button" className="ui-control text-xs text-ink-300 underline-offset-2 hover:underline" onClick={() => setMode((m) => (m === 'sign-in' ? 'sign-up' : 'sign-in'))}>
          {mode === 'sign-in' ? 'Create an account instead' : 'I already have an account'}
        </button>
      )}
      {state.error && <p className="text-xs text-down">{state.error}</p>}
      {state.info && <p className="text-xs text-ink-200">{state.info}</p>}
    </form>
  );
}
