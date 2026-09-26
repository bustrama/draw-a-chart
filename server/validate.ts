import type { PreviewMessage } from '../src/sync/protocol.ts';

export const LIMITS = {
  /** Changes per request (the client sends at most 50). */
  maxBatch: 200,
  /** Serialized size of one drawing (the client caps strokes at 2 000 points, far below this). */
  maxDataBytes: 262_144,
  maxPrevOpIds: 16,
  maxProvider: 32,
  maxSymbol: 32,
  maxTimeframe: 8,
  /** Live preview points ([time, price, pressure] triples; the client sends at most ~400). */
  maxPreviewPoints: 3 * 2_000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['ink', 'line', 'glyph', 'stamp']);

/** A change that passed validation. Ids are lower-case; `data` is serialized JSON (null = not sent). */
export interface ValidChange {
  readonly id: string;
  readonly opId: string;
  readonly baseRev: number;
  readonly prevOpIds: readonly string[];
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly data: string | null;
  readonly deleted: boolean;
}

export type CheckedChange = { readonly ok: true; readonly change: ValidChange } | { readonly ok: false; readonly id: string; readonly error: string };

/** Parses the body of `POST /api/changes`: request-level problems fail it, per-change ones don't. */
export function parseChangesRequest(body: unknown): { ok: true; changes: CheckedChange[] } | { ok: false; error: string } {
  if (!isRecord(body) || !Array.isArray(body.changes)) return { ok: false, error: 'expected {"changes": [...]}' };
  if (body.changes.length > LIMITS.maxBatch) return { ok: false, error: `too many changes in one request (max ${LIMITS.maxBatch})` };
  return { ok: true, changes: body.changes.map(checkChange) };
}

export function checkChange(input: unknown): CheckedChange {
  if (!isRecord(input)) return invalid('', 'change must be an object');
  const rawId = typeof input.id === 'string' ? input.id : '';
  if (!UUID.test(rawId)) return invalid(rawId, 'id must be a UUID');
  const fail = (error: string) => invalid(rawId.toLowerCase(), error);

  if (typeof input.op_id !== 'string' || !UUID.test(input.op_id)) return fail('op_id must be a UUID');
  const baseRev = input.base_rev ?? 0;
  if (typeof baseRev !== 'number' || !Number.isSafeInteger(baseRev) || baseRev < 0) return fail('base_rev must be a non-negative integer');
  const deleted = input.deleted ?? false;
  if (typeof deleted !== 'boolean') return fail('deleted must be a boolean');
  const prev = Array.isArray(input.prev_op_ids) ? input.prev_op_ids : [];
  if (prev.length > LIMITS.maxPrevOpIds) return fail(`too many prev_op_ids (max ${LIMITS.maxPrevOpIds})`);
  if (!prev.every((p): p is string => typeof p === 'string' && UUID.test(p))) return fail('prev_op_ids must be UUIDs');
  if (!isText(input.provider, LIMITS.maxProvider)) return fail(`provider must be 1-${LIMITS.maxProvider} characters`);
  if (!isText(input.symbol, LIMITS.maxSymbol)) return fail(`symbol must be 1-${LIMITS.maxSymbol} characters`);
  if (!isText(input.timeframe, LIMITS.maxTimeframe)) return fail(`timeframe must be 1-${LIMITS.maxTimeframe} characters`);
  if (typeof input.kind !== 'string' || !KINDS.has(input.kind)) return fail('kind must be ink, line, glyph or stamp');

  let data: string | null = null;
  if (input.data !== undefined && input.data !== null) {
    data = JSON.stringify(input.data);
    if (Buffer.byteLength(data, 'utf8') >= LIMITS.maxDataBytes) return fail(`data too large (max ${LIMITS.maxDataBytes} bytes)`);
  }
  return {
    ok: true,
    change: {
      id: rawId.toLowerCase(),
      opId: input.op_id.toLowerCase(),
      baseRev,
      prevOpIds: prev.map((p) => p.toLowerCase()),
      provider: input.provider,
      symbol: input.symbol,
      timeframe: input.timeframe,
      kind: input.kind,
      data,
      deleted,
    },
  };
}

/**
 * A relayed preview, rebuilt from its known fields only: a bad message cannot break other devices'
 * rendering, and nothing unchecked (e.g. deeply nested extra fields) is ever re-serialized.
 */
export function toPreviewMessage(m: unknown): PreviewMessage | null {
  if (!isRecord(m) || !isRecord(m.style)) return null;
  const { chart, id, device, style, end, pts } = m;
  if (!isText(chart, 100) || !isText(id, 64) || !isText(device, 64)) return null;
  if (!isText(style.color, 32) || typeof style.width !== 'number' || !Number.isFinite(style.width)) return null;
  if (end !== null && end !== 'commit' && end !== 'discard') return null;
  if (!Array.isArray(pts) || pts.length % 3 !== 0 || pts.length > LIMITS.maxPreviewPoints) return null;
  if (!pts.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { chart, id, device, style: { color: style.color, width: style.width }, pts: pts as number[], end };
}

function invalid(id: string, error: string): CheckedChange {
  return { ok: false, id, error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max;
}
