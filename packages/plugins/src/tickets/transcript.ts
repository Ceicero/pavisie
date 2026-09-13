// Pure, unit-tested: builds the JSON and HTML transcript payloads. Every piece of user-controlled text is run
// through `escapeHtml` before being placed in the HTML document, and attachment hrefs are restricted to
// http(s) URLs (never `javascript:`/`data:`) so a message like `<script>...` or a malicious filename/URL can
// never execute in a viewer's browser (ARCHITECTURE.md §15: "HTML transcripts escaped, strict CSP <meta>").
import { escapeHtml } from '@pavisie/core';

export interface TranscriptAttachment {
  name: string;
  url: string;
}

export interface TranscriptMessage {
  id: string;
  authorId: string;
  authorTag: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: TranscriptAttachment[];
}

export interface TranscriptTicketMeta {
  number: number;
  guildId: string;
  openerId: string;
  subject: string | null;
  status: string;
  mode: string;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  tags: string[];
  intake: Record<string, string> | null;
}

export interface JsonTranscript {
  ticket: TranscriptTicketMeta;
  messageCount: number;
  messages: TranscriptMessage[];
  generatedAt: string;
}

/** Builds the JSON transcript payload — the full message list, stored/served as-is. */
export function buildJsonTranscript(
  ticket: TranscriptTicketMeta,
  messages: TranscriptMessage[],
): JsonTranscript {
  return { ticket, messageCount: messages.length, messages, generatedAt: new Date().toISOString() };
}

/** Restricts an attachment/link href to http(s); anything else (javascript:, data:, malformed) becomes `#`. */
function safeHref(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // fall through
  }
  return '#';
}

const CSP_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; script-src 'none';\">";

function renderMessage(message: TranscriptMessage): string {
  const attachmentsHtml =
    message.attachments.length > 0
      ? `<div class="attachments">${message.attachments
          .map(
            (a) =>
              `<a href="${escapeHtml(safeHref(a.url))}" rel="noopener noreferrer nofollow">${escapeHtml(a.name)}</a>`,
          )
          .join(' ')}</div>`
      : '';

  const contentHtml = escapeHtml(message.content).replace(/\n/g, '<br>');

  return `<div class="msg">
    <div class="meta"><span class="author">${escapeHtml(message.authorTag)}</span> <span class="id">(${escapeHtml(message.authorId)})</span> · <span class="time">${escapeHtml(message.createdAt)}</span>${message.editedAt ? ' <span class="edited">(edited)</span>' : ''}</div>
    <div class="content">${contentHtml || '<span class="empty">[no text content]</span>'}</div>
    ${attachmentsHtml}
  </div>`;
}

/** Builds a self-contained, strict-CSP HTML transcript document (escaped, no inline scripts, links only for attachments). */
export function buildHtmlTranscript(ticket: TranscriptTicketMeta, messages: TranscriptMessage[]): string {
  const intakeHtml =
    ticket.intake && Object.keys(ticket.intake).length > 0
      ? `<div class="intake"><h2>Intake form</h2>${Object.entries(ticket.intake)
          .map(
            ([label, value]) =>
              `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value).replace(/\n/g, '<br>')}</p>`,
          )
          .join('')}</div>`
      : '';

  const rowsHtml =
    messages.length > 0 ? messages.map(renderMessage).join('\n') : '<p class="empty">No messages.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${CSP_META}
<title>Ticket #${ticket.number} transcript</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background:#0a0a0a; color:#e5e5e5; margin:0; padding:24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 16px 0 8px; color:#a3a3a3; }
  .header { margin-bottom: 20px; border-bottom: 1px solid #333; padding-bottom: 12px; }
  .header p { font-size: 13px; color:#a3a3a3; margin: 2px 0; }
  .msg { border-bottom: 1px solid #262626; padding: 10px 0; }
  .meta { font-size: 12px; color:#a3a3a3; margin-bottom: 4px; }
  .author { font-weight:600; color:#fafafa; }
  .content { white-space: pre-wrap; word-break: break-word; }
  .empty { color:#737373; font-style: italic; }
  .attachments { margin-top: 4px; font-size: 12px; }
  .attachments a { color:#8a8a8a; margin-right:8px; }
  .intake { margin-bottom: 20px; padding: 12px; border: 1px solid #262626; border-radius: 6px; }
  .intake p { font-size: 13px; margin: 4px 0; }
</style>
</head>
<body>
  <div class="header">
    <h1>Ticket #${ticket.number}${ticket.subject ? `: ${escapeHtml(ticket.subject)}` : ''}</h1>
    <p>Opener: ${escapeHtml(ticket.openerId)} &middot; Mode: ${escapeHtml(ticket.mode)} &middot; Status: ${escapeHtml(ticket.status)} &middot; Opened: ${escapeHtml(ticket.createdAt)}</p>
    ${ticket.closedAt ? `<p>Closed: ${escapeHtml(ticket.closedAt)} by ${escapeHtml(ticket.closedBy ?? 'unknown')}${ticket.closeReason ? ` — ${escapeHtml(ticket.closeReason)}` : ''}</p>` : ''}
    ${ticket.tags.length > 0 ? `<p>Tags: ${ticket.tags.map((t) => escapeHtml(t)).join(', ')}</p>` : ''}
  </div>
  ${intakeHtml}
  ${rowsHtml}
</body>
</html>`;
}
