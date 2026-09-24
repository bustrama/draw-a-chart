import { chartKeyString, type ChartKey } from './model';
import { DrawingDocument } from './store';

/** Provides the drawing document for a chart; persistence implementations plug in here. */
export interface DocumentSource {
  open(key: ChartKey): DrawingDocument;
}

/** Documents kept in memory only (used when IndexedDB is unavailable, and in tests). */
export class MemoryDocumentSource implements DocumentSource {
  private readonly docs = new Map<string, DrawingDocument>();

  open(key: ChartKey): DrawingDocument {
    const k = chartKeyString(key);
    let doc = this.docs.get(k);
    if (!doc) {
      doc = new DrawingDocument(key);
      this.docs.set(k, doc);
    }
    return doc;
  }
}
