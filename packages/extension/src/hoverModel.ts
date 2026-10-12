import type { Location } from '@refyntra/contracts';

// Hover on MediatR requests: which handler handles it, with a link. Pure: unit-tested with vitest (no vscode).

/**
 * Cheap text gate before asking the backend: a PascalCase name on a line that looks like MediatR (a request type
 * declaration, a `new X(` sent with Send/Publish, or a name ending in Query/Command/Request/Notification/Event).
 */
export function mayBeMediatRRequest(word: string, lineText: string): boolean {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(word)) return false;
  if (/(Query|Command|Request|Notification|Event)$/.test(word)) return true;
  return /\b(IRequest|INotification|IStreamRequest)\b/.test(lineText) || /\.(Send|Publish|CreateStream)\s*\(/.test(lineText);
}

export interface HoverHandler {
  label: string;
  location?: Location;
  notification: boolean;
}

/** Markdown of the hover: one line per handler; each name links to Refyntra's own open command (file: URIs only). */
export function mediatrHoverMarkdown(subject: string, handlers: readonly HoverHandler[], file: (uri: string) => string): string | undefined {
  if (handlers.length === 0) return undefined;
  const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
  const link = (h: HoverHandler) => {
    if (!h.location || !h.location.uri.startsWith('file:')) return esc(h.label);
    const args = encodeURIComponent(JSON.stringify([h.location]));
    return `[${esc(h.label)}](command:refyntra.openLocation?${args} "Open ${esc(file(h.location.uri))}:${h.location.range.start.line + 1}")`;
  };
  const kind = handlers.every((h) => h.notification) ? 'notification handler' : 'handler';
  const head = `**MediatR** — ${esc(subject)} is handled by ${handlers.length === 1 ? `the ${kind}` : `${handlers.length} ${kind}s`}:`;
  return [head, '', ...handlers.map((h) => `- ${link(h)}${h.location ? ` — ${esc(file(h.location.uri))}:${h.location.range.start.line + 1}` : ''}`)].join('\n');
}
