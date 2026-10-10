import type { StackFrame } from './stackTraceParse';
import { basenameOf } from './stackTracePaths';
import { FRAME_STATUS_PHRASE, type FrameStatus } from './terminology';

// Words for stack frames (pure: unit-tested). The icon of a frame is decoration only; its status is always in words.

function place(f: StackFrame): string | undefined {
  if (!f.file) return undefined;
  return f.line !== undefined ? `${basenameOf(f.file)}:${f.line}` : basenameOf(f.file);
}

/** Tree description: "OrderService.cs:57 · your code". */
export function frameDescription(f: StackFrame, status: FrameStatus): string {
  return [place(f), FRAME_STATUS_PHRASE[status], f.afterAsyncBoundary ? 'after await' : undefined].filter(Boolean).join(' · ');
}

/** Screen-reader label: "Frame 1 of 2: Ns.Type.Method (async), OrderService.cs line 57, your code". */
export function frameAccessibleLabel(f: StackFrame, at: { index: number; count: number; status: FrameStatus }): string {
  const where = f.file ? `${basenameOf(f.file)}${f.line !== undefined ? ` line ${f.line}` : ''}` : 'no file';
  const parts = [`Frame ${at.index + 1} of ${at.count}: ${f.function}`, where, FRAME_STATUS_PHRASE[at.status]];
  if (f.afterAsyncBoundary) parts.push('after await');
  return parts.join(', ');
}

/** Group heading: "System.InvalidOperationException: Order 42 was not found". */
export function groupLabel(g: { exceptionType?: string | undefined; message?: string | undefined }): string {
  if (!g.exceptionType) return 'Stack trace';
  return g.message ? `${g.exceptionType}: ${g.message}` : g.exceptionType;
}

export function groupAccessibleLabelFor(g: { exceptionType?: string | undefined; message?: string | undefined; depth: number }, frameCount: number): string {
  const kind = g.depth > 0 ? `Inner exception, level ${g.depth}` : 'Exception';
  return `${kind}: ${groupLabel(g)}, ${frameCount} ${frameCount === 1 ? 'frame' : 'frames'}`;
}

/** Message shown when the frame's line is past the end of the file found for it. */
export function lineMovedNotice(file: string, line: number, lineCount: number): string {
  return `Line ${line} is past the end of ${basenameOf(file)} (${lineCount} lines): the file changed since the trace was written, so the line may have moved.`;
}
