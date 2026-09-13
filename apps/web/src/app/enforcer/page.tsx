import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { Faq } from '../../components/Faq';
import { EmbedMock } from '../../components/EmbedMock';
import { ButtonLink } from '../../components/Button';
import { enforcerWorkflow, enforcerPrivacyPoints, enforcerFaq } from '../../content/enforcer';

export const metadata: Metadata = {
  title: 'Admin Enforcer',
  description:
    "How Entrophy's policy-driven, hands-off moderation works: flag, review, decide, ledger, appeal.",
};

export default function EnforcerPage() {
  return (
    <>
      <Section
        headingLevel={1}
        eyebrow="Admin Enforcer"
        title="Moderators decide. The bot does the rest."
        subtitle="Enforcer is policy-driven, hands-off moderation: the bot flags possible violations, a moderator reviews the exact chat context and picks a decision, the bot performs it and talks to the player — and every step is bookkept in a read-only ledger and the database."
      >
        <ButtonLink href="/features/enforcer" variant="outline">
          Enforcer command reference →
        </ButtonLink>
      </Section>

      <Section eyebrow="How it works" title="Flag → review → decide → ledger → appeal">
        <ol
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Enforcer workflow steps"
        >
          {enforcerWorkflow.map((step) => (
            <li key={step.title}>
              <Glass className="h-full p-6">
                <h3 className="text-base font-semibold text-grey-7">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-grey-3">{step.body}</p>
              </Glass>
            </li>
          ))}
        </ol>
      </Section>

      <Section eyebrow="Workflow diagram" title="The path a flagged message takes">
        <Glass className="overflow-x-auto p-6 sm:p-10">
          <EnforcerDiagram />
        </Glass>
      </Section>

      <Section
        eyebrow="Bookkeeping"
        title="What the ledger actually looks like"
        subtitle="A real ledger entry (illustrative — names and content below are examples, not real data) posted to a staff-only channel the bot alone can write to."
      >
        <div className="max-w-xl">
          <EmbedMock
            author="Entrophy — Enforcer ledger"
            title="Record #E-142 — DECISION"
            fields={[
              { name: 'User', value: '@example.user (912...045)', inline: true },
              { name: 'When', value: 'Today at 4:12 PM', inline: true },
              { name: 'Action', value: 'Timeout — 1 hour', inline: true },
              { name: 'Decided by', value: '@example.moderator', inline: true },
              { name: 'Policy', value: 'External links — unapproved domains', inline: true },
              { name: 'Case', value: '#118', inline: true },
              { name: 'Context', value: '"...check out this giveaway link..." [Jump to message]' },
            ]}
            footer="Source: automatic flag · Entrophy Enforcer"
          />
        </div>
      </Section>

      <Section eyebrow="Privacy & transparency" title="What's actually stored, and what isn't">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {enforcerPrivacyPoints.map((point) => (
            <li key={point}>
              <Glass className="h-full p-5 text-sm leading-relaxed text-grey-3">{point}</Glass>
            </li>
          ))}
        </ul>
      </Section>

      <Section eyebrow="FAQ" title="Common questions">
        <Faq items={enforcerFaq} />
      </Section>
    </>
  );
}

function EnforcerDiagram() {
  const steps = [
    'Message / manual flag',
    'Policy match',
    'Flag-queue embed',
    'Moderator reviews context',
    'Decision executed',
    'Ledger entry',
  ];
  return (
    <svg
      viewBox="0 0 1180 160"
      className="min-w-[900px]"
      role="img"
      aria-label="Diagram: message flows through policy match, flag queue, moderator review, decision, and ledger entry"
    >
      <title>Enforcer workflow diagram</title>
      {steps.map((label, i) => {
        const x = 20 + i * 200;
        return (
          <g key={label}>
            <rect
              x={x}
              y={50}
              width={170}
              height={60}
              rx={12}
              fill="none"
              stroke="var(--grey-4)"
              strokeWidth={1.5}
            />
            <foreignObject x={x} y={50} width={170} height={60}>
              <div
                className="flex h-full items-center justify-center px-2 text-center text-xs text-grey-6"
                style={{ fontFamily: 'inherit' }}
              >
                {label}
              </div>
            </foreignObject>
            {i < steps.length - 1 && (
              <line
                x1={x + 170}
                y1={80}
                x2={x + 200}
                y2={80}
                stroke="var(--grey-3)"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            )}
          </g>
        );
      })}
      <defs>
        <marker id="arrow" markerWidth={8} markerHeight={8} refX={6} refY={4} orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--grey-3)" />
        </marker>
      </defs>
    </svg>
  );
}
