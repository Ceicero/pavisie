'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AiUsageDailyPointDto } from '@pavisie/types/ai';
import { EmptyState } from '@pavisie/ui';

export interface UsageChartProps {
  daily: AiUsageDailyPointDto[];
  dailyTokenBudget: number;
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

interface TooltipPayloadEntry {
  name: string;
  value: number;
  color: string;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
            {entry.name}
          </span>
          <span className="tabular-nums">{entry.value.toLocaleString()}</span>
        </p>
      ))}
      <p className="mt-1 border-t border-border pt-1 font-medium tabular-nums">
        Total: {total.toLocaleString()}
      </p>
    </div>
  );
}

/** Monochrome stacked daily token usage (prompt vs. completion), with a dashed reference line at the server's daily budget (ARCHITECTURE.md §20: greyscale series, dashed/dotted differentiation). */
export function UsageChart({ daily, dailyTokenBudget }: UsageChartProps) {
  if (daily.length === 0) {
    return (
      <EmptyState
        title="No AI usage yet"
        description="Once /ask, /summarize, /draft, or /mod-assist are used, daily token usage will show up here."
      />
    );
  }

  const data = daily.map((d) => ({
    date: formatShortDate(d.date),
    Prompt: d.promptTokens,
    Completion: d.completionTokens,
  }));
  const maxDailyTotal = Math.max(...daily.map((d) => d.totalTokens), 0);
  const showBudgetLine = dailyTokenBudget > 0 && dailyTokenBudget <= maxDailyTotal * 3;

  return (
    <div className="space-y-3">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap={4}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickLine={false}
              axisLine={{ stroke: 'hsl(var(--border))' }}
            />
            <YAxis
              tickFormatter={formatTokens}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--muted))' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Prompt" stackId="tokens" fill="hsl(var(--foreground))" radius={[0, 0, 0, 0]} />
            <Bar
              dataKey="Completion"
              stackId="tokens"
              fill="hsl(var(--muted-foreground))"
              radius={[4, 4, 0, 0]}
            />
            {showBudgetLine ? (
              <ReferenceLine
                y={dailyTokenBudget}
                stroke="hsl(var(--foreground))"
                strokeDasharray="6 4"
                strokeWidth={1.5}
                label={{
                  value: 'Daily budget',
                  position: 'insideTopRight',
                  fontSize: 11,
                  fill: 'hsl(var(--foreground))',
                }}
              />
            ) : null}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">View as table</summary>
        <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-2 py-1 font-medium">Date</th>
                <th className="px-2 py-1 font-medium">Prompt</th>
                <th className="px-2 py-1 font-medium">Completion</th>
                <th className="px-2 py-1 font-medium">Total</th>
                <th className="px-2 py-1 font-medium">Requests</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <td className="px-2 py-1 tabular-nums">{d.date}</td>
                  <td className="px-2 py-1 tabular-nums">{d.promptTokens.toLocaleString()}</td>
                  <td className="px-2 py-1 tabular-nums">{d.completionTokens.toLocaleString()}</td>
                  <td className="px-2 py-1 tabular-nums">{d.totalTokens.toLocaleString()}</td>
                  <td className="px-2 py-1 tabular-nums">{d.requests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
