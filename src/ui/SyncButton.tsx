import { useState, useSyncExternalStore } from 'react';
import { readSyncServer } from '../app/runtimeConfig';
import { LOGIN_REQUIRED, loginUrl } from '../sync/serverRemote';
import type { SessionState, SyncSession } from '../sync/session';
import type { SyncEngine, SyncState, SyncStatus } from '../sync/SyncEngine';
import { CloudIcon } from './icons';
import { Popover } from './Popover';

interface Props {
  readonly sync: SyncEngine | null;
  readonly session: SyncSession | null;
}

const LOCAL_ONLY: SyncStatus = { state: 'local-only', pending: 0, error: null, lastSyncedAt: null };
const NO_SESSION: SessionState = { status: 'unknown', userId: null, error: null };
const noop = () => () => undefined;

interface Look {
  readonly dot: string;
  readonly label: string;
}

const STATE_LOOK: Record<SyncState, Look> = {
  'local-only': { dot: 'bg-ink-400', label: 'Sync off — saved on this device' },
  'signed-out': { dot: 'bg-amber-400', label: 'Connecting to the sync server…' },
  connecting: { dot: 'bg-amber-400', label: 'Connecting…' },
  syncing: { dot: 'bg-accent animate-pulse', label: 'Syncing…' },
  synced: { dot: 'bg-up', label: 'Synced' },
  offline: { dot: 'bg-amber-400', label: 'Offline — changes queued' },
  error: { dot: 'bg-down', label: 'Sync error — retrying' },
};

/** Before the server has said who this device is, the session tells why. */
function look(status: SyncStatus, session: SessionState, needsLogin: boolean): Look {
  if (needsLogin) return { dot: 'bg-amber-400', label: 'Sign in again to keep syncing' };
  if (status.state === 'signed-out' && session.status === 'unreachable') return { dot: 'bg-down', label: 'Sync server unreachable' };
  if (status.state === 'signed-out' && session.status === 'signed-out') return { dot: 'bg-down', label: 'Not signed in to the sync server' };
  return STATE_LOOK[status.state];
}

function detail(status: SyncStatus): string {
  const n = status.pending;
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (status.state === 'local-only') return 'Stored in this browser only';
  if (status.state === 'signed-out') return n > 0 ? `${changes} saved here, sent once the server is reachable` : 'Drawings are saved on this device meanwhile';
  const last = status.lastSyncedAt ? ` · last sync ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : '';
  return `${n > 0 ? `${changes} waiting to sync` : 'No pending changes'}${last}`;
}

export function SyncButton({ sync, session }: Props) {
  const [open, setOpen] = useState(false);
  const status = useSyncExternalStore(sync?.subscribe ?? noop, sync?.getStatus ?? (() => LOCAL_ONLY));
  const sessionState = useSyncExternalStore(session?.subscribe ?? noop, session?.getState ?? (() => NO_SESSION));
  // Queued edits only matter when they are waiting for a server.
  const showPending = status.pending > 0 && status.state !== 'local-only';
  const error = status.error ?? (status.state === 'signed-out' ? sessionState.error : null);
  // A login proxy (e.g. Cloudflare Access) redirected a sync request: its session expired.
  const needsLogin = error === LOGIN_REQUIRED || sessionState.error === LOGIN_REQUIRED;
  const current = look(status, sessionState, needsLogin);
  return (
    <div className="relative">
      <button
        type="button"
        title={`${current.label}${showPending ? ` (${status.pending} pending)` : ''}`}
        aria-label="Sync status"
        onClick={() => setOpen((o) => !o)}
        data-testid="sync-button"
        data-sync-state={status.state}
        className={`ui-control relative flex h-8 items-center gap-1.5 rounded-md px-2 ${open ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'}`}
      >
        <CloudIcon width={18} height={18} />
        <span className={`inline-block h-2 w-2 rounded-full ${current.dot}`} />
        {showPending && (
          <span className="text-[11px] tabular-nums" data-testid="pending-count">
            {status.pending}
          </span>
        )}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="w-72" testId="sync-panel">
          <div className="flex items-start gap-2" data-testid="sync-summary">
            <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${current.dot}`} />
            <div className="min-w-0">
              <p className="font-medium text-ink-100">{current.label}</p>
              <p className="text-xs text-ink-400">{detail(status)}</p>
              {error && <p className="mt-1 text-xs break-words text-down">{error}</p>}
            </div>
          </div>
          <div className="mt-3 border-t border-ink-700 pt-3">
            {status.state === 'local-only' ? (
              <p className="text-xs leading-relaxed text-ink-300">Sync is turned off here, so drawings stay in this browser.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-xs leading-relaxed text-ink-300">Drawings sync through your draw-a-chart server: every device that opens this app stays in sync.</p>
                {needsLogin && (
                  // A real navigation (not fetch), past the service worker, so the login page can show.
                  <a
                    href={loginUrl(readSyncServer() ?? '')}
                    data-testid="sync-login"
                    className="ui-control flex h-9 items-center justify-center rounded-lg bg-accent font-medium text-ink-950"
                  >
                    Sign in again
                  </a>
                )}
                <button
                  type="button"
                  className="ui-control h-9 rounded-lg bg-ink-700 text-ink-100 hover:bg-ink-600"
                  onClick={() => {
                    session?.refresh();
                    void sync?.syncNow();
                  }}
                >
                  Sync now
                </button>
              </div>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
