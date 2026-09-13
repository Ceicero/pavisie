import * as React from 'react';
import { cn } from '../lib/cn';

export interface EmbedPreviewField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedPreviewAuthor {
  name: string;
  iconUrl?: string;
  url?: string;
}

export interface EmbedPreviewFooter {
  text: string;
  iconUrl?: string;
}

/** Plain object shape accepted by `EmbedPreview` — mirrors a Discord embed closely enough to preview it. */
export interface EmbedPreviewData {
  title?: string;
  description?: string;
  /** Hex color, e.g. `#e5e5e5`. */
  color?: string;
  fields?: EmbedPreviewField[];
  author?: EmbedPreviewAuthor;
  footer?: EmbedPreviewFooter;
  thumbnailUrl?: string;
  imageUrl?: string;
  timestamp?: string | Date;
}

export interface EmbedPreviewProps {
  embed: EmbedPreviewData;
  /** Plain message text shown above the embed, e.g. what `@everyone` pings would read. */
  content?: string;
  botName?: string;
  botAvatarUrl?: string;
  className?: string;
}

const DEFAULT_COLOR = '#e5e5e5';

/** Renders a small subset of Discord markdown: bold, italic, inline code, and links. Newlines are left as-is for `whitespace-pre-wrap`. */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`(.+?)`|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const [whole, bold, italicStar, italicUnderscore, code, linkText, linkUrl] = match;
    if (bold !== undefined) {
      nodes.push(<strong key={key++}>{bold}</strong>);
    } else if (italicStar !== undefined || italicUnderscore !== undefined) {
      nodes.push(<em key={key++}>{italicStar ?? italicUnderscore}</em>);
    } else if (code !== undefined) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10"
        >
          {code}
        </code>,
      );
    } else if (linkText !== undefined && linkUrl !== undefined) {
      nodes.push(
        <a
          key={key++}
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[#00a8fc] hover:underline"
        >
          {linkText}
        </a>,
      );
    } else {
      nodes.push(whole);
    }
    lastIndex = match.index + whole.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function formatTimestamp(ts: string | Date): string {
  const date = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Discord-style embed + message preview, rendered from a plain object — used by the welcome/embed
 * builder and role-panel/ticket-panel editors to show admins exactly what members will see.
 */
export function EmbedPreview({
  embed,
  content,
  botName = 'Pavisie',
  botAvatarUrl,
  className,
}: EmbedPreviewProps) {
  const hasFields = embed.fields && embed.fields.length > 0;
  const nowLabel = React.useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()),
    [],
  );

  return (
    <div className={cn('rounded-lg bg-[#313338] p-4 font-sans text-[#dbdee1]', className)}>
      <div className="flex gap-3">
        <div className="mt-0.5 h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[#5865f2]">
          {botAvatarUrl ? (
            <img src={botAvatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white">
              {botName.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-white">{botName}</span>
            <span className="rounded bg-[#5865f2] px-1 py-px text-[10px] font-medium uppercase text-white">
              Bot
            </span>
            <span className="text-xs text-[#949ba4]">Today at {nowLabel}</span>
          </div>

          {content ? (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-[#dbdee1]">
              {renderInlineMarkdown(content)}
            </p>
          ) : null}

          <div
            className="mt-2 max-w-[520px] rounded-[4px] border-l-4 bg-[#2b2d31] py-2 pl-3 pr-4"
            style={{
              borderColor: embed.color && /^#[0-9a-fA-F]{6}$/.test(embed.color) ? embed.color : DEFAULT_COLOR,
            }}
          >
            <div className="flex gap-4">
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                {embed.author?.name ? (
                  <div className="flex items-center gap-2 font-medium text-white">
                    {embed.author.iconUrl ? (
                      <img src={embed.author.iconUrl} alt="" className="h-5 w-5 rounded-full" />
                    ) : null}
                    <span>{embed.author.name}</span>
                  </div>
                ) : null}

                {embed.title ? (
                  <p className="text-base font-semibold text-white">{renderInlineMarkdown(embed.title)}</p>
                ) : null}

                {embed.description ? (
                  <p className="whitespace-pre-wrap break-words leading-snug text-[#dbdee1]">
                    {renderInlineMarkdown(embed.description)}
                  </p>
                ) : null}

                {hasFields ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
                    {embed.fields!.map((field, i) => (
                      <div key={i} className={cn('min-w-0', field.inline === false ? 'col-span-2' : '')}>
                        <p className="text-sm font-semibold text-white">
                          {renderInlineMarkdown(field.name || '​')}
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm text-[#dbdee1]">
                          {renderInlineMarkdown(field.value || '​')}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}

                {embed.imageUrl ? (
                  <img src={embed.imageUrl} alt="" className="mt-2 max-h-64 max-w-full rounded" />
                ) : null}

                {embed.footer?.text || embed.timestamp ? (
                  <div className="flex items-center gap-2 pt-2 text-xs text-[#949ba4]">
                    {embed.footer?.iconUrl ? (
                      <img src={embed.footer.iconUrl} alt="" className="h-5 w-5 rounded-full" />
                    ) : null}
                    <span>
                      {embed.footer?.text}
                      {embed.footer?.text && embed.timestamp ? ' • ' : ''}
                      {embed.timestamp ? formatTimestamp(embed.timestamp) : ''}
                    </span>
                  </div>
                ) : null}
              </div>

              {embed.thumbnailUrl ? (
                <img src={embed.thumbnailUrl} alt="" className="h-20 w-20 shrink-0 rounded object-cover" />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
