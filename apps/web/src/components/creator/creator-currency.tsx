'use client';

import * as React from 'react';
import { Coins, Scale } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Input,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@pavisie/ui';
import type { CreatorChannelEconomySettingsDto, CreatorEconomyLeaderboardDto } from '@pavisie/types/creator';
import { ApiClientError } from '@/lib/dashboard/api';
import {
  useCreatorDiscordStatus,
  useCreatorEconomy,
  useCreatorEconomyLeaderboard,
  useUpdateCreatorEconomy,
} from '@/lib/creator/queries';
import {
  ECONOMY_NAME_MAX,
  ECONOMY_NUMERIC_FIELDS,
  ECONOMY_SYMBOL_MAX,
  buildPatch,
  formatAmount,
  toDraft,
  validateDraft,
  type EconomyDraft,
  type EconomyNumericField,
} from '@/lib/creator/economy-form';
import { ErrorState } from '@/components/dashboard/error-state';
import { CreatorCurrencyAdjustDialog } from './creator-currency-adjust-dialog';

/**
 * The "Currency" section: the streamer's OWN virtual currency for their channel. It is held per Twitch channel, so it
 * works with no Discord server and no chat-bot connection. Honest by construction — nothing here shows numbers that
 * do not come from the API, and the currency only exists once the streamer saves (never created by merely viewing).
 */
export function CreatorCurrency() {
  const economyQuery = useCreatorEconomy();

  if (economyQuery.error) {
    return <ErrorState error={economyQuery.error} onRetry={() => economyQuery.refetch()} />;
  }
  if (economyQuery.isLoading || !economyQuery.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const { configured, settings } = economyQuery.data;

  return (
    <section aria-labelledby="currency-heading" className="space-y-4">
      <h2 id="currency-heading" className="text-lg font-semibold">
        Currency
      </h2>
      <CurrencySettingsCard configured={configured} settings={settings} />
      <TopViewersCard configured={configured} symbol={settings.currencySymbol} />
    </section>
  );
}

function reportError(toast: ReturnType<typeof useToast>['toast'], title: string) {
  return (err: unknown) =>
    toast({
      title,
      description: err instanceof ApiClientError ? err.message : 'Please try again.',
      variant: 'destructive',
    });
}

function CurrencySettingsCard({
  configured,
  settings,
}: {
  configured: boolean;
  settings: CreatorChannelEconomySettingsDto;
}) {
  const update = useUpdateCreatorEconomy();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EconomyDraft>(() => toDraft(settings));

  // Re-sync the form whenever the saved settings change (after a save, or a refetch).
  React.useEffect(() => {
    setDraft(toDraft(settings));
  }, [settings]);

  const errors = validateDraft(draft);
  const valid = Object.keys(errors).length === 0;
  const patch = valid ? buildPatch(settings, draft) : {};
  const dirty = Object.keys(patch).length > 0;

  function setNumber(field: EconomyNumericField, value: string) {
    setDraft((d) => ({ ...d, numbers: { ...d.numbers, [field]: value } }));
  }

  function toggleEnabled(next: boolean) {
    update.mutate(
      { enabled: next },
      {
        onSuccess: () =>
          toast({
            title: next ? 'Your currency is on' : 'Your currency is off',
            description: next ? 'It can take up to 30 seconds to start working in your chat.' : undefined,
            variant: 'success',
          }),
        onError: reportError(toast, 'Could not update your currency'),
      },
    );
  }

  function save() {
    if (!valid || !dirty) return;
    update.mutate(patch, {
      onSuccess: () =>
        toast({
          title: 'Currency settings saved',
          description: 'Changes reach your chat within about 30 seconds.',
          variant: 'success',
        }),
      onError: reportError(toast, 'Could not save the settings'),
    });
  }

  function numberField(field: EconomyNumericField, hint?: string) {
    const bounds = ECONOMY_NUMERIC_FIELDS[field];
    return (
      <FormField key={field} label={bounds.label} hint={hint} error={errors[field]}>
        <Input
          type="number"
          inputMode="numeric"
          min={bounds.min}
          max={bounds.max}
          value={draft.numbers[field]}
          onChange={(e) => setNumber(field, e.target.value)}
          disabled={update.isPending}
        />
      </FormField>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4" aria-hidden="true" />
            Your channel currency
          </CardTitle>
          <p className="max-w-xl text-sm text-muted-foreground">
            Viewers earn and spend a virtual currency in your chat (!balance, !daily, !give, !top) and on your Twitch
            panel. It has no real-world value and cannot be bought or cashed out. It belongs to your channel, so it
            works without a Discord server.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {configured ? (
              <Badge variant={settings.enabled ? 'success' : 'secondary'}>{settings.enabled ? 'on' : 'off'}</Badge>
            ) : (
              <Badge variant="secondary">not set up</Badge>
            )}
          </div>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={toggleEnabled}
          disabled={update.isPending}
          aria-label="Currency enabled in my channel"
        />
      </CardHeader>

      <CardContent className="space-y-6">
        {!configured ? (
          <Alert>
            <AlertTitle>Nothing is set up yet</AlertTitle>
            <AlertDescription>
              Turn the currency on, or adjust the settings below and save. Nothing is created until you do.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Currency name" error={errors.currencyName}>
            <Input
              value={draft.currencyName}
              maxLength={ECONOMY_NAME_MAX}
              onChange={(e) => setDraft((d) => ({ ...d, currencyName: e.target.value }))}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Symbol" hint="A short symbol or emoji, shown next to amounts." error={errors.currencySymbol}>
            <Input
              value={draft.currencySymbol}
              maxLength={ECONOMY_SYMBOL_MAX}
              onChange={(e) => setDraft((d) => ({ ...d, currencySymbol: e.target.value }))}
              disabled={update.isPending}
            />
          </FormField>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Daily reward (!daily)</legend>
          <p className="text-xs text-muted-foreground">
            A viewer can claim once every 20 hours. Claiming again within 48 hours keeps their streak going.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField('dailyMinAmount')}
            {numberField('dailyMaxAmount')}
            {numberField('streakBonusPerDay', 'Extra per streak day.')}
            {numberField('streakBonusMax', 'The most streak bonus a claim can add.')}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Giving to another viewer (!give)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField('giveMinAmount')}
            {numberField('giveMaxAmount')}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Earning from chat</legend>
          <div className="flex items-center gap-3">
            <Switch
              checked={draft.earnEnabled}
              onCheckedChange={(checked) => setDraft((d) => ({ ...d, earnEnabled: checked }))}
              disabled={update.isPending}
              aria-label="Award currency for chatting while live"
            />
            <span className="text-sm text-muted-foreground">
              Award currency for chatting while your stream is live. You and well-known chat bots never earn.
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {numberField('earnPerMessage')}
            {numberField('earnCooldownSeconds')}
            {numberField('earnDailyCap', '0 turns earning off.')}
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={!valid || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          <p className="text-xs text-muted-foreground">Changes reach your chat within about 30 seconds.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function TopViewersCard({ configured, symbol }: { configured: boolean; symbol: string }) {
  const board = useCreatorEconomyLeaderboard(configured);
  const discord = useCreatorDiscordStatus();
  const [adjusting, setAdjusting] = React.useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" aria-hidden="true" />
            Top viewers
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Who has earned the most, and who holds the most right now. You can add to or remove from a viewer's
            balance; every change is written to the currency's ledger with your reason.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdjusting(true)} disabled={!configured}>
          Adjust a balance
        </Button>
      </CardHeader>

      <CardContent>
        {!configured ? (
          <EmptyState
            title="Set up your currency first"
            description="Once your currency is on, your top viewers appear here."
          />
        ) : board.error ? (
          <ErrorState error={board.error} onRetry={() => board.refetch()} />
        ) : board.isLoading || !board.data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <ViewersTabs data={board.data} symbol={symbol} />
        )}
        {discord.data?.linked ? (
          <p className="mt-4 text-xs text-muted-foreground">
            Your Discord server&apos;s <code>/economy leaderboard platform:global</code> shows Discord and Twitch
            together, each in its own currency. Balances are never merged.
          </p>
        ) : null}
      </CardContent>

      <CreatorCurrencyAdjustDialog open={adjusting} onOpenChange={setAdjusting} symbol={symbol} />
    </Card>
  );
}

function ViewersTabs({ data, symbol }: { data: CreatorEconomyLeaderboardDto; symbol: string }) {
  return (
    <Tabs defaultValue="earned">
      <TabsList>
        <TabsTrigger value="earned">Most earned</TabsTrigger>
        <TabsTrigger value="balance">Highest balance</TabsTrigger>
      </TabsList>

      <TabsContent value="earned">
        {data.earned.length === 0 ? (
          <EmptyState
            title="No one has earned anything yet"
            description="Viewers show up here after they claim !daily or earn from chat."
          />
        ) : (
          <ViewersTable
            amountLabel="Earned (lifetime)"
            symbol={symbol}
            rows={data.earned.map((r) => ({ id: r.viewerUserId, name: r.displayName, amount: r.earned }))}
          />
        )}
      </TabsContent>

      <TabsContent value="balance">
        {data.balance.length === 0 ? (
          <EmptyState title="No viewer holds any currency yet" description="Balances appear here once viewers have some." />
        ) : (
          <ViewersTable
            amountLabel="Balance"
            symbol={symbol}
            rows={data.balance.map((r) => ({ id: r.viewerUserId, name: r.displayName, amount: r.balance }))}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}

function ViewersTable({
  rows,
  amountLabel,
  symbol,
}: {
  rows: { id: string; name: string | null; amount: string }[];
  amountLabel: string;
  symbol: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Viewer</TableHead>
          <TableHead className="text-right">{amountLabel}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={row.id}>
            <TableCell className="text-muted-foreground">{i + 1}</TableCell>
            <TableCell className="font-medium">{row.name ?? 'Twitch viewer'}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatAmount(row.amount)} {symbol}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
