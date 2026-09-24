import { describe, expect, it } from 'vitest';
import type { Drawing } from './model';
import { DrawingDocument } from './store';

const style = { color: '#ffffff', width: 2 };
const key = { provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h' } as const;

function line(id: string, createdAt = 1, t2 = 2): Drawing {
  return { id, kind: 'line', style, createdAt, t1: 0, p1: 1, t2, p2: 3 };
}

describe('DrawingDocument', () => {
  it('creates, undoes and redoes a stroke', () => {
    const doc = new DrawingDocument(key);
    doc.commit('draw', [{ op: 'put', drawing: line('a') }]);
    expect(doc.store.size).toBe(1);
    expect(doc.undo()).toBe(true);
    expect(doc.store.size).toBe(0);
    expect(doc.redo()).toBe(true);
    expect(doc.store.get('a')).toEqual(line('a'));
  });

  it('undoes deletion by restoring the exact previous drawings', () => {
    const doc = new DrawingDocument(key);
    doc.commit('draw', [{ op: 'put', drawing: line('a') }]);
    doc.commit('draw', [{ op: 'put', drawing: line('b', 2) }]);
    doc.commit('erase', [
      { op: 'delete', id: 'a' },
      { op: 'delete', id: 'b' },
    ]);
    expect(doc.store.size).toBe(0);
    doc.undo();
    expect(doc.store.all().map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('undoes an in-place modification', () => {
    const doc = new DrawingDocument(key);
    doc.commit('draw', [{ op: 'put', drawing: line('a') }]);
    doc.commit('move', [{ op: 'put', drawing: line('a', 1, 99) }]);
    doc.undo();
    expect(doc.store.get('a')).toMatchObject({ t2: 2 });
    doc.redo();
    expect(doc.store.get('a')).toMatchObject({ t2: 99 });
  });

  it('clears redo after a new command and ignores no-op commands', () => {
    const doc = new DrawingDocument(key);
    doc.commit('draw', [{ op: 'put', drawing: line('a') }]);
    doc.undo();
    doc.commit('draw', [{ op: 'put', drawing: line('b') }]);
    expect(doc.history.canRedo).toBe(false);
    expect(doc.commit('erase', [{ op: 'delete', id: 'missing' }])).toBe(false);
    expect(doc.history.canUndo).toBe(true);
    doc.undo();
    expect(doc.history.canUndo).toBe(false);
  });

  it('does not record remote changes in the history', () => {
    const doc = new DrawingDocument(key);
    const origins: string[] = [];
    doc.store.subscribe((c) => origins.push(c.origin));
    doc.store.apply([{ op: 'put', drawing: line('r') }], 'remote');
    expect(doc.history.canUndo).toBe(false);
    expect(origins).toEqual(['remote']);
  });

  it('keeps paint order by creation time', () => {
    const doc = new DrawingDocument(key);
    doc.commit('draw', [{ op: 'put', drawing: line('late', 5) }]);
    doc.commit('draw', [{ op: 'put', drawing: line('early', 1) }]);
    expect(doc.store.all().map((d) => d.id)).toEqual(['early', 'late']);
  });
});
