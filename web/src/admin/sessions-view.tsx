import * as React from 'react';

import type { AdminApiClient, AdminSession, AdminSessionStatus } from '@/admin/api-client';
import { adminErrorMessage } from '@/admin/error-message';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { directionOf, translate, type Locale } from '@/i18n';

export interface SessionsViewProps {
  client: AdminApiClient;
  locale: Locale;
  /** Page size; the Admin API caps `limit` at 100. */
  pageSize?: number;
  /** The admin BFF has not signed the user in yet. */
  signedOut?: boolean;
}

type StatusFilter = 'all' | AdminSessionStatus;

interface Filters {
  userId: string;
  clientId: string;
  status: StatusFilter;
}

const EMPTY_FILTERS: Filters = { userId: '', clientId: '', status: 'all' };

const statusVariant = (status: AdminSessionStatus) =>
  status === 'active' ? 'secondary' : status === 'revoked' ? 'destructive' : 'outline';

/**
 * Session administration (docs/api.md 3.7).
 *
 * Every action is authorized and scoped by the API; the UI only hides actions it knows are
 * impossible (revoking an already revoked session).
 */
export function SessionsView({
  client,
  locale,
  pageSize = 25,
  signedOut = false,
}: SessionsViewProps) {
  const t = React.useCallback(
    (key: string, values?: Record<string, string | number>) => translate(locale, key, values),
    [locale],
  );
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }),
    [locale],
  );

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = React.useState<Filters>(EMPTY_FILTERS);
  const [sessions, setSessions] = React.useState<AdminSession[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(!signedOut);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (targetPage: number, active: Filters) => {
      if (signedOut) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await client.listSessions({
          page: targetPage,
          limit: pageSize,
          ...(active.userId.trim() === '' ? {} : { userId: active.userId.trim() }),
          ...(active.clientId.trim() === '' ? {} : { clientId: active.clientId.trim() }),
          ...(active.status === 'all' ? {} : { status: active.status }),
        });
        setSessions(result.items);
        setTotal(result.total);
        setPage(result.page);
      } catch (caught) {
        setSessions([]);
        setTotal(0);
        setError(adminErrorMessage(caught, locale));
      } finally {
        setLoading(false);
      }
    },
    [client, locale, pageSize, signedOut],
  );

  React.useEffect(() => {
    void load(1, EMPTY_FILTERS);
  }, [load]);

  const apply = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setApplied(filters);
    setNotice(null);
    await load(1, filters);
  };

  const reset = async () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setNotice(null);
    await load(1, EMPTY_FILTERS);
  };

  const revoke = async (session: AdminSession) => {
    setBusyId(session.id);
    setError(null);
    setNotice(null);
    try {
      await client.revokeSession(session.id);
      setNotice(t('admin.sessions.revoked', { id: session.id }));
      await load(page, applied);
    } catch (caught) {
      setError(adminErrorMessage(caught, locale));
    } finally {
      setBusyId(null);
    }
  };

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
  };

  return (
    <Card dir={directionOf(locale)} lang={locale} data-testid="sessions-view">
      <CardHeader>
        <CardTitle>{t('admin.sessions.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {signedOut ? (
          <Alert data-testid="sessions-signed-out">
            <AlertTitle>{t('admin.signedOutTitle')}</AlertTitle>
            <AlertDescription>{t('admin.signedOutBody')}</AlertDescription>
          </Alert>
        ) : null}

        <form className="flex flex-wrap items-end gap-2" role="search" onSubmit={apply}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sessions-user">{t('admin.sessions.userId')}</Label>
            <Input
              id="sessions-user"
              value={filters.userId}
              onChange={(event) => setFilters({ ...filters, userId: event.target.value })}
              autoComplete="off"
              dir="ltr"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sessions-client">{t('admin.sessions.clientId')}</Label>
            <Input
              id="sessions-client"
              value={filters.clientId}
              onChange={(event) => setFilters({ ...filters, clientId: event.target.value })}
              autoComplete="off"
              dir="ltr"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sessions-status">{t('admin.sessions.status')}</Label>
            <Select
              value={filters.status}
              onValueChange={(value) => setFilters({ ...filters, status: value as StatusFilter })}
            >
              <SelectTrigger id="sessions-status" aria-label={t('admin.sessions.status')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.sessions.status.all')}</SelectItem>
                <SelectItem value="active">{t('admin.sessions.status.active')}</SelectItem>
                <SelectItem value="revoked">{t('admin.sessions.status.revoked')}</SelectItem>
                <SelectItem value="expired">{t('admin.sessions.status.expired')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" variant="outline" disabled={signedOut}>
            {t('admin.sessions.apply')}
          </Button>
          <Button type="button" variant="outline" disabled={signedOut} onClick={() => void reset()}>
            {t('admin.sessions.reset')}
          </Button>
        </form>

        <div aria-live="polite" className="min-h-6 text-sm">
          {error === null ? null : (
            <Alert variant="destructive" data-testid="sessions-error">
              <AlertTitle>{t('admin.errorTitle')}</AlertTitle>
              <AlertDescription>
                <p>{error}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void load(page, applied)}
                >
                  {t('admin.sessions.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {notice === null ? null : (
            <p className="text-muted-foreground" data-testid="sessions-notice">
              {notice}
            </p>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner label={t('common.loading')} />
            <span>{t('common.loading')}</span>
          </div>
        ) : (
          <Table>
            <caption className="pb-2 text-start text-sm text-muted-foreground">
              {t('admin.sessions.caption', { total })}
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.sessions.columnUser')}</TableHead>
                <TableHead>{t('admin.sessions.columnClient')}</TableHead>
                <TableHead>{t('admin.sessions.columnStatus')}</TableHead>
                <TableHead>{t('admin.sessions.columnCreated')}</TableHead>
                <TableHead>{t('admin.sessions.columnLastSeen')}</TableHead>
                <TableHead>{t('admin.sessions.columnAddress')}</TableHead>
                <TableHead>{t('admin.columnActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} data-testid="sessions-empty">
                    {t('admin.sessions.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                sessions.map((session) => (
                  <TableRow key={session.id} data-testid={`session-row-${session.id}`}>
                    <TableCell>
                      <span className="block font-mono text-xs" dir="ltr">
                        {session.userId}
                      </span>
                    </TableCell>
                    <TableCell>
                      <bdi>{session.clientId ?? t('admin.audit.none')}</bdi>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(session.status)}>
                        {t(`admin.sessions.status.${session.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDate(session.createdAt)}</TableCell>
                    <TableCell>{formatDate(session.lastSeenAt)}</TableCell>
                    <TableCell>
                      <bdi>{session.ip ?? t('admin.audit.none')}</bdi>
                      {session.userAgent === null ? null : (
                        <span className="block max-w-48 truncate text-xs text-muted-foreground">
                          <bdi>{session.userAgent}</bdi>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={busyId === session.id || session.status !== 'active'}
                        aria-label={t('admin.sessions.revokeFor', { id: session.id })}
                        onClick={() => void revoke(session)}
                      >
                        {t('admin.sessions.revoke')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={page <= 1 || loading}
            onClick={() => void load(page - 1, applied)}
          >
            {t('admin.previous')}
          </Button>
          <span className="text-sm text-muted-foreground" data-testid="sessions-page">
            {t('admin.pageOf', { page, lastPage })}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={page >= lastPage || loading}
            onClick={() => void load(page + 1, applied)}
          >
            {t('admin.next')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
