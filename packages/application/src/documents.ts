import { Emitter } from './util';

export interface TrackedDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  dirty: boolean;
}

export type DocumentEventKind = 'open' | 'change' | 'save' | 'close';

export interface DocumentEvent {
  kind: DocumentEventKind;
  uri: string;
  languageId: string;
  version: number;
  /** Full text after the event (absent for close). */
  text?: string;
  /** Global monotonic document sequence (application owned). */
  documentSequence: number;
  /** Global monotonic workspace revision (application owned). */
  workspaceRevision: number;
}

/**
 * Single owner of `workspaceRevision` and `documentSequence`. Every editor event is recorded
 * immediately; debounce applies to analysis, never to recording that something changed.
 */
export class DocumentTracker {
  private docs = new Map<string, TrackedDocument>();
  private _revision = 0;
  private _sequence = 0;
  private readonly emitter = new Emitter<DocumentEvent>();
  readonly onDidRecord = this.emitter.event;

  get revision(): number {
    return this._revision;
  }

  get sequence(): number {
    return this._sequence;
  }

  /** Non-document input changed (solution choice, settings, provider route): bump revision only. */
  bumpRevision(): number {
    return ++this._revision;
  }

  open(uri: string, languageId: string, version: number, text: string, dirty = false): DocumentEvent {
    this.docs.set(uri, { uri, languageId, version, text, dirty });
    return this.record('open', uri, languageId, version, text);
  }

  change(uri: string, languageId: string, version: number, text: string, dirty = true): DocumentEvent {
    const existing = this.docs.get(uri);
    this.docs.set(uri, { uri, languageId, version, text, dirty });
    // A change for a document we never saw opened is treated as an open (full text either way).
    return this.record(existing ? 'change' : 'open', uri, languageId, version, text);
  }

  save(uri: string, languageId: string, version: number, text: string): DocumentEvent {
    this.docs.set(uri, { uri, languageId, version, text, dirty: false });
    return this.record('save', uri, languageId, version, text);
  }

  close(uri: string): DocumentEvent | undefined {
    const existing = this.docs.get(uri);
    if (!existing) return undefined;
    this.docs.delete(uri);
    return this.record('close', uri, existing.languageId, existing.version, undefined);
  }

  get(uri: string): TrackedDocument | undefined {
    return this.docs.get(uri);
  }

  /** Open documents in open order (used for full replay after restart). */
  openDocuments(): TrackedDocument[] {
    return [...this.docs.values()];
  }

  private record(kind: DocumentEventKind, uri: string, languageId: string, version: number, text: string | undefined): DocumentEvent {
    const event: DocumentEvent = {
      kind,
      uri,
      languageId,
      version,
      ...(text !== undefined ? { text } : {}),
      documentSequence: ++this._sequence,
      workspaceRevision: ++this._revision,
    };
    this.emitter.fire(event);
    return event;
  }
}
