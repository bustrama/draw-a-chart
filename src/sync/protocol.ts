/**
 * Wire protocol between the app and the self-hosted sync server (`server/`).
 * Types only, and no imports: the server imports this file with `import type`, which Node's type
 * stripping erases, so the server image needs no client code.
 */

/** A drawing as stored and returned by the server. `data` is the chart-space drawing (drawing/model). */
export interface RemoteRow {
  readonly id: string;
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly data: unknown;
  readonly deleted: boolean;
  readonly rev: number;
  /** Server time of the last change (ISO 8601, never decreasing): the pull cursor. */
  readonly updated_at: string;
}

/** One change in `POST /api/changes`. */
export interface ChangePayload {
  readonly id: string;
  readonly op_id: string;
  /** Server revision this change was made on (0 = the client has never seen a server version). */
  readonly base_rev: number;
  /** Earlier op ids of this client for the drawing that were sent but never acknowledged. */
  readonly prev_op_ids: readonly string[];
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly data: unknown;
  readonly deleted: boolean;
}

/**
 * - applied: stored (new revision in `row`);
 * - duplicate: this op was already applied (a retry after a lost response);
 * - conflict: the drawing changed meanwhile; `row` is the server version, which wins;
 * - rejected: the id belongs to another user;
 * - invalid: malformed or oversized; reported per change so it cannot block the rest.
 */
export type ChangeStatus = 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'invalid';

export interface ChangeResult {
  readonly id: string;
  readonly status: ChangeStatus;
  readonly row: RemoteRow | null;
  /** Reason for 'invalid'. */
  readonly error?: string;
}

export interface PreviewStyle {
  readonly color: string;
  readonly width: number;
}

/** Ephemeral live preview of a stroke in progress on another device. Never stored. */
export interface PreviewMessage {
  readonly chart: string;
  readonly id: string;
  readonly style: PreviewStyle;
  /** [time, price, pressure] triples. Empty when `end` is set. */
  readonly pts: readonly number[];
  /**
   * 'commit': the stroke was committed (keep the ghost until the durable drawing arrives);
   * 'discard': the stroke was abandoned (remove the ghost now); null while drawing.
   */
  readonly end: 'commit' | 'discard' | null;
  readonly device: string;
}

// ---- HTTP -------------------------------------------------------------------------------------

/** `GET /api/session`: who the server says this client is. */
export interface SessionInfo {
  readonly user: { readonly id: string };
  /** How the server identified the caller. Only 'none' (single user, no sign-in) exists today. */
  readonly auth: 'none';
  /**
   * Identifies the server database's history. A different value than last time means the server
   * was restored from a backup or replaced: devices then resynchronize (see SyncEngine).
   */
  readonly generation: string;
}

export interface ChangesRequest {
  readonly changes: readonly ChangePayload[];
}

export interface ChangesResponse {
  readonly results: readonly ChangeResult[];
}

/** `GET /api/drawings?provider&symbol&timeframe&since&limit`: rows with updated_at >= since, ascending. */
export interface PullResponse {
  readonly rows: readonly RemoteRow[];
}

export interface ErrorResponse {
  readonly error: string;
}

// ---- WebSocket /api/live ------------------------------------------------------------------------

export type ServerMessage =
  /** First message of every connection (also after a server restart). */
  | { readonly type: 'hello'; readonly user: { readonly id: string }; readonly generation: string }
  /** Drawings changed by any device of this user (including the receiver's own writes). */
  | { readonly type: 'rows'; readonly rows: readonly RemoteRow[] }
  | { readonly type: 'preview'; readonly message: PreviewMessage }
  /** Heartbeat, so proxies (e.g. Cloudflare) keep the idle connection open. */
  | { readonly type: 'ping' };

export type ClientMessage = { readonly type: 'preview'; readonly message: PreviewMessage };
