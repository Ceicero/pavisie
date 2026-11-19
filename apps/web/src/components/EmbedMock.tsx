interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface EmbedMockProps {
  author?: string;
  title: string;
  description?: string;
  fields: EmbedField[];
  footer?: string;
}

/** Discord-style embed mock for illustrating the Enforcer ledger without a live Discord connection.
 * The accent bar uses gold-5, matching the bot embed colour (`BRAND.color`, ARCHITECTURE.md §20). */
export function EmbedMock({ author, title, description, fields, footer }: EmbedMockProps) {
  return (
    <div className="flex overflow-hidden rounded-md bg-ink-3 font-sans text-sm shadow-lg">
      <div className="w-1 shrink-0 bg-gold-5" aria-hidden="true" />
      <div className="min-w-0 flex-1 px-4 py-3">
        {author && <p className="text-xs font-medium text-grey-4">{author}</p>}
        <p className="mt-1 font-semibold text-grey-7">{title}</p>
        {description && <p className="mt-1 whitespace-pre-line text-grey-3">{description}</p>}
        {fields.length > 0 && (
          <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            {fields.map((field) => (
              <div key={field.name} className={field.inline ? '' : 'sm:col-span-2'}>
                <dt className="text-xs font-semibold text-grey-6">{field.name}</dt>
                <dd className="text-sm text-grey-3">{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {footer && <p className="mt-3 text-xs text-grey-3">{footer}</p>}
      </div>
    </div>
  );
}
