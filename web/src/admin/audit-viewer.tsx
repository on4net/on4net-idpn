import * as React from 'react';

import {
  type AdminApiClient,
  type AdminAuditEvent,
  type AuditEventFilters,
  type AuditExportFormat,
} from '@/admin/api-client';
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
import { translate, type Locale } from '@/i18n';

export interface AuditViewerProps {
  client: AdminApiClient;
  locale: Locale;
  /** Page size; the Admin API caps `limit` at 100. */
  pageSize?: number;
  /** The admin BFF has not signed the user in yet. */
  signedOut?: boolean;
}

type ResultFilter = 'all' | 'success' | 'failure';

interface Filters {
  from: string;
  to: string;
  action: string;
  actorId: string;
  clientId: string;
  targetType: string;
  result: ResultFilter;
}

const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  action: '',
  actorId: '',
  clientId: '',
  targetType: '',
  result: 'all',
};

type Notice =
  { kind: 'idle' } | { kind: 'info'; message: string } | { kind: 'error'; message: string };

const toIso = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/** Converts form state to query parameters; empty fields are omitted. */
export function auditFilterParams(filters: Filters): AuditEventFilters {
  const from = toIso(filters.from);
  const to = toIso(filters.to);
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(filters.action.trim() === '' ? {} : { action: filters.action.trim() }),
    ...(filters.actorId.trim() === '' ? {} : { actorId: filters.actorId.trim() }),
    ...(filters.clientId.trim() === '' ? {} : { clientId: filters.clientId.trim() }),
    ...(filters.targetType.trim() === '' ? {} : { targetType: filters.targetType.trim() }),
    ...(filters.result === 'all' ? {} : { result: filters.result }),
  };
}

const resultVariant = (result: AdminAuditEvent['result']) =>
  result === 'success' ? 'secondary' : 'destructive';

/**
 * Audit trail viewer (docs/api.md 3.8, docs/security.md 10).
 *
 * Export is a separate permission; the API answers 403 when the caller lacks it, and the
 * error is surfaced here instead of hiding the button.
 */
export function AuditViewer({
  client,
  locale,
  pageSize = 25,
  signedOut = false,
}: AuditViewerProps) {
  const t = React.useCallback(
    (key: string, values?: Record<string, string | number>) => translate(locale, key, values),
    [locale],
  );
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }),
    [locale],
  );

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = React.useState<Filters>(EMPTY_FILTERS);
  const [events, setEvents] = React.useState<AdminAuditEvent[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(!signedOut);
  const [exporting, setExporting] = React.useState(false);
  const [format, setFormat] = React.useState<AuditExportFormat>('csv');
  const [notice, setNotice] = React.useState<Notice>({ kind: 'idle' });

  const load = React.useCallback(
    async (targetPage: number, active: Filters) => {
      if (signedOut) {
        return;
      }
      setLoading(true);
      try {
        const result = await client.listAuditEvents({
          page: targetPage,
          limit: pageSize,
          ...auditFilterParams(active),
        });
        setEvents(result.items);
        setTotal(result.total);
        setPage(result.page);
      } catch (error) {
        setEvents([]);
        setTotal(0);
        setNotice({ kind: 'error', message: adminErrorMessage(error, locale) });
      } finally {
        setLoading(false);
      }
    },
    [client, locale, pageSize, signedOut],
  );

  React.useEffect(() => {
    void load(1, EMPTY_FILTERS);
  }, [load]);

  const update = (field: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [field]: value }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied(filters);
    void load(1, filters);
  };

  const reset = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    void load(1, EMPTY_FILTERS);
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const blob = await client.exportAuditEvents({
        format,
        ...auditFilterParams(applied),
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `audit-events.${format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice({ kind: 'info', message: t('admin.audit.exported') });
    } catch (error) {
      setNotice({ kind: 'error', message: adminErrorMessage(error, locale) });
    } finally {
      setExporting(false);
    }
  };

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card data-testid="admin-audit-viewer">
      <CardHeader>
        <CardTitle>{t('admin.audit.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {signedOut ? (
          <Alert data-testid="admin-audit-signed-out">
            <AlertTitle>{t('admin.signedOutTitle')}</AlertTitle>
            <AlertDescription>{t('admin.signedOutBody')}</AlertDescription>
          </Alert>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={submit}
          role="search"
          aria-label={t('admin.audit.filters')}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-from">{t('admin.audit.from')}</Label>
            <Input
              id="audit-from"
              type="datetime-local"
              value={filters.from}
              onChange={(event) => update('from', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-to">{t('admin.audit.to')}</Label>
            <Input
              id="audit-to"
              type="datetime-local"
              value={filters.to}
              onChange={(event) => update('to', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-action">{t('admin.audit.action')}</Label>
            <Input
              id="audit-action"
              value={filters.action}
              autoComplete="off"
              onChange={(event) => update('action', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-actor">{t('admin.audit.actorId')}</Label>
            <Input
              id="audit-actor"
              value={filters.actorId}
              autoComplete="off"
              onChange={(event) => update('actorId', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-client">{t('admin.audit.clientId')}</Label>
            <Input
              id="audit-client"
              value={filters.clientId}
              autoComplete="off"
              onChange={(event) => update('clientId', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-target">{t('admin.audit.targetType')}</Label>
            <Input
              id="audit-target"
              value={filters.targetType}
              autoComplete="off"
              onChange={(event) => update('targetType', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-result">{t('admin.audit.result')}</Label>
            <Select value={filters.result} onValueChange={(value) => update('result', value)}>
              <SelectTrigger id="audit-result" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.audit.result.all')}</SelectItem>
                <SelectItem value="success">{t('admin.audit.result.success')}</SelectItem>
                <SelectItem value="failure">{t('admin.audit.result.failure')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" variant="outline">
            {t('admin.audit.apply')}
          </Button>
          <Button type="button" variant="ghost" onClick={reset}>
            {t('admin.audit.reset')}
          </Button>
        </form>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-format">{t('admin.audit.format')}</Label>
            <Select
              value={format}
              onValueChange={(value) => setFormat(value === 'ndjson' ? 'ndjson' : 'csv')}
            >
              <SelectTrigger id="audit-format" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="ndjson">NDJSON</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={signedOut || exporting}
            onClick={() => void runExport()}
            data-testid="admin-audit-export"
          >
            {exporting ? t('admin.audit.exporting') : t('admin.audit.export')}
          </Button>
        </div>

        <div aria-live="polite" className="min-h-6 text-sm">
          {notice.kind === 'error' ? (
            <Alert variant="destructive" data-testid="admin-audit-error">
              <AlertTitle>{t('admin.errorTitle')}</AlertTitle>
              <AlertDescription>{notice.message}</AlertDescription>
            </Alert>
          ) : null}
          {notice.kind === 'info' ? (
            <p className="text-muted-foreground" data-testid="admin-audit-notice">
              {notice.message}
            </p>
          ) : null}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner label={t('common.loading')} />
            <span>{t('common.loading')}</span>
          </div>
        ) : (
          <Table>
            <caption className="pb-2 text-start text-sm text-muted-foreground">
              {t('admin.audit.caption', { total })}
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.audit.columnTime')}</TableHead>
                <TableHead>{t('admin.audit.columnAction')}</TableHead>
                <TableHead>{t('admin.audit.columnActor')}</TableHead>
                <TableHead>{t('admin.audit.columnTarget')}</TableHead>
                <TableHead>{t('admin.audit.columnClient')}</TableHead>
                <TableHead>{t('admin.audit.columnResult')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} data-testid="admin-audit-empty">
                    {t('admin.audit.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                events.map((event) => (
                  <TableRow key={event.id} data-testid={`admin-audit-row-${event.id}`}>
                    <TableCell className="whitespace-nowrap">
                      {dateFormatter.format(new Date(event.occurredAt))}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.action}</TableCell>
                    <TableCell>
                      {event.actorId ?? t('admin.audit.systemActor')}
                      <span className="block text-xs text-muted-foreground">{event.actorType}</span>
                    </TableCell>
                    <TableCell>
                      {event.targetType ?? t('admin.audit.none')}
                      {event.targetId === null ? null : (
                        <span className="block text-xs text-muted-foreground">
                          {event.targetId}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{event.clientId ?? t('admin.audit.none')}</TableCell>
                    <TableCell>
                      <Badge variant={resultVariant(event.result)}>
                        {t(`admin.audit.result.${event.result}`)}
                      </Badge>
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
          <span className="text-sm text-muted-foreground" data-testid="admin-audit-page">
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
