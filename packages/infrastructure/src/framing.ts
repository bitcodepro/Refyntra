/** LSP-style `Content-Length` framing over byte streams (protocol-v1 "Transport"). */

export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

export class FramingError extends Error {
  constructor(
    readonly reasonCode: 'MalformedFrame' | 'FrameTooLarge',
    message: string,
  ) {
    super(message);
    this.name = 'FramingError';
  }
}

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. After the first error it stops decoding: a broken stream cannot be resynchronised safely,
 * so the caller treats it as a fatal transport failure.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  private expected: number | undefined;
  private failed = false;

  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onError: (error: FramingError) => void,
    private readonly maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.expected === undefined) {
        const end = this.buffer.indexOf(HEADER_END);
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) return this.fail('MalformedFrame', 'Frame header too long or missing terminator');
          return;
        }
        const header = this.buffer.subarray(0, end).toString('ascii');
        this.buffer = this.buffer.subarray(end + HEADER_END.length);
        let length: number | undefined;
        for (const line of header.split('\r\n')) {
          const sep = line.indexOf(':');
          if (sep <= 0) return this.fail('MalformedFrame', 'Malformed frame header line');
          const name = line.slice(0, sep).trim().toLowerCase();
          const value = line.slice(sep + 1).trim();
          if (name === 'content-length') {
            if (!/^\d+$/.test(value)) return this.fail('MalformedFrame', 'Invalid Content-Length');
            length = Number(value);
          }
        }
        if (length === undefined) return this.fail('MalformedFrame', 'Missing Content-Length');
        if (length > this.maxMessageBytes) return this.fail('FrameTooLarge', `Frame of ${length} bytes exceeds the ${this.maxMessageBytes} byte limit`);
        this.expected = length;
      }
      if (this.buffer.length < this.expected) return;
      const body = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return this.fail('MalformedFrame', 'Frame body is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.fail('MalformedFrame', 'Frame body is not a JSON-RPC object');
      this.onMessage(parsed);
      if (this.failed) return;
    }
  }

  private fail(code: FramingError['reasonCode'], message: string): void {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.onError(new FramingError(code, message));
  }
}
