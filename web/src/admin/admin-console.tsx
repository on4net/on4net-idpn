import * as React from 'react';

import { AuditViewer } from '@/admin/audit-viewer';
import type { AdminApiClient, AdminUser } from '@/admin/api-client';
import { adminErrorMessage } from '@/admin/error-message';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { translate, type Locale } from '@/i18n';

export interface AdminConsoleProps {
  client: AdminApiClient;
  locale: Locale;
  /** Page size; the Admin API caps `limit` at 100. */
  pageSize?: number;
  /** Shown when the caller has no token yet (the admin BFF has not signed the user in). */
  signedOut?: boolean;
}

type Notice =
  { kind: 'idle' } | { kind: 'info'; message: string } | { kind: 'error'; message: string };

const statusVariant = (status: AdminUser['status']) =>
  status === 'active' ? 'secondary' : status === 'disabled' ? 'destructive' : 'outline';

/**
 * Global admin console: search, create, edit and disable users (`docs/api.md` 3.2).
 *
 * Every action is authorized by the API; the UI only hides what the caller cannot use.
 */
export function AdminConsole({
  client,
  locale,
  pageSize = 25,
  signedOut = false,
}: AdminConsoleProps) {
  const t = React.useCallback(
    (key: string, values?: Record<string, string | number>) => translate(locale, key, values),
    [locale],
  );

  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [query, setQuery] = React.useState('');
  const [appliedQuery, setAppliedQuery] = React.useState('');
  const [loading, setLoading] = React.useState(!signedOut);
  const [busyUserId, setBusyUserId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice>({ kind: 'idle' });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (targetPage: number, search: string) => {
      if (signedOut) {
        return;
      }
      setLoading(true);
      try {
        const result = await client.listUsers({
          page: targetPage,
          limit: pageSize,
          ...(search === '' ? {} : { q: search }),
          sort: 'createdAt:desc',
        });
        setUsers(result.items);
        setTotal(result.total);
        setPage(result.page);
      } catch (error) {
        setUsers([]);
        setTotal(0);
        setNotice({ kind: 'error', message: adminErrorMessage(error, locale) });
      } finally {
        setLoading(false);
      }
    },
    [client, locale, pageSize, signedOut],
  );

  React.useEffect(() => {
    void load(1, '');
  }, [load]);

  const runAction = async (user: AdminUser, action: () => Promise<unknown>, messageKey: string) => {
    setBusyUserId(user.id);
    try {
      await action();
      setNotice({ kind: 'info', message: t(messageKey, { email: user.email }) });
      await load(page, appliedQuery);
    } catch (error) {
      setNotice({ kind: 'error', message: adminErrorMessage(error, locale) });
    } finally {
      setBusyUserId(null);
    }
  };

  const resetPassword = async (user: AdminUser) => {
    setBusyUserId(user.id);
    try {
      const result = await client.resetPassword(user.id);
      setTempPassword(result.temporaryPassword ?? null);
      setNotice({ kind: 'info', message: t('admin.passwordReset', { email: user.email }) });
      await load(page, appliedQuery);
    } catch (error) {
      setNotice({ kind: 'error', message: adminErrorMessage(error, locale) });
    } finally {
      setBusyUserId(null);
    }
  };

  const submitSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    setAppliedQuery(query.trim());
    await load(1, query.trim());
  };

  const submitCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();
    const displayName = String(form.get('displayName') ?? '').trim();
    try {
      const result = await client.createUser({ username, email, displayName, locale });
      setCreateOpen(false);
      setTempPassword(result.temporaryPassword ?? null);
      setNotice({ kind: 'info', message: t('admin.created', { email }) });
      await load(1, '');
    } catch (error) {
      setNotice({ kind: 'error', message: adminErrorMessage(error, locale) });
    }
  };

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="flex flex-col gap-4" data-testid="admin-console" lang={locale}>
      <Tabs defaultValue="users" className="flex flex-col gap-4">
        <TabsList>
          <TabsTrigger value="users">{t('admin.tabs.users')}</TabsTrigger>
          <TabsTrigger value="audit">{t('admin.tabs.audit')}</TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>{t('admin.title')}</CardTitle>
              <Button type="button" onClick={() => setCreateOpen(true)} disabled={signedOut}>
                {t('admin.create')}
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {signedOut ? (
                <Alert data-testid="admin-signed-out">
                  <AlertTitle>{t('admin.signedOutTitle')}</AlertTitle>
                  <AlertDescription>{t('admin.signedOutBody')}</AlertDescription>
                </Alert>
              ) : null}

              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={submitSearch}
                role="search"
              >
                <div className="flex flex-col gap-1">
                  <Label htmlFor="admin-search">{t('admin.search')}</Label>
                  <Input
                    id="admin-search"
                    name="q"
                    value={query}
                    placeholder={t('admin.searchPlaceholder')}
                    onChange={(event) => setQuery(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <Button type="submit" variant="outline">
                  {t('admin.searchAction')}
                </Button>
              </form>

              <div aria-live="polite" className="min-h-6 text-sm">
                {notice.kind === 'error' ? (
                  <Alert variant="destructive" data-testid="admin-error">
                    <AlertTitle>{t('admin.errorTitle')}</AlertTitle>
                    <AlertDescription>{notice.message}</AlertDescription>
                  </Alert>
                ) : null}
                {notice.kind === 'info' ? (
                  <p className="text-muted-foreground" data-testid="admin-notice">
                    {notice.message}
                  </p>
                ) : null}
              </div>

              {tempPassword === null ? null : (
                <Alert data-testid="admin-temp-password">
                  <AlertTitle>{t('admin.tempPasswordTitle')}</AlertTitle>
                  <AlertDescription>
                    <code className="break-all">{tempPassword}</code>
                  </AlertDescription>
                </Alert>
              )}

              {loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner label={t('common.loading')} />
                  <span>{t('common.loading')}</span>
                </div>
              ) : (
                <Table>
                  <caption className="pb-2 text-start text-sm text-muted-foreground">
                    {t('admin.caption', { total })}
                  </caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('admin.columnUser')}</TableHead>
                      <TableHead>{t('admin.columnEmail')}</TableHead>
                      <TableHead>{t('admin.columnStatus')}</TableHead>
                      <TableHead>{t('admin.columnActions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} data-testid="admin-empty">
                          {t('admin.empty')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      users.map((user) => (
                        <TableRow key={user.id} data-testid={`admin-row-${user.username}`}>
                          <TableCell>
                            <span className="font-medium">{user.displayName}</span>
                            <span className="block text-xs text-muted-foreground">
                              {user.username}
                            </span>
                          </TableCell>
                          <TableCell>{user.email}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(user.status)}>
                              {t(`admin.status.${user.status}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busyUserId === user.id}
                              onClick={() => void resetPassword(user)}
                            >
                              {t('admin.resetPassword')}
                            </Button>
                            {user.status === 'disabled' ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busyUserId === user.id}
                                onClick={() =>
                                  void runAction(
                                    user,
                                    () => client.enableUser(user.id),
                                    'admin.enabled',
                                  )
                                }
                              >
                                {t('admin.enable')}
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={busyUserId === user.id}
                                onClick={() =>
                                  void runAction(
                                    user,
                                    () => client.disableUser(user.id),
                                    'admin.disabled',
                                  )
                                }
                              >
                                {t('admin.disable')}
                              </Button>
                            )}
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
                  onClick={() => void load(page - 1, appliedQuery)}
                >
                  {t('admin.previous')}
                </Button>
                <span className="text-sm text-muted-foreground" data-testid="admin-page">
                  {t('admin.pageOf', { page, lastPage })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={page >= lastPage || loading}
                  onClick={() => void load(page + 1, appliedQuery)}
                >
                  {t('admin.next')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="audit">
          <AuditViewer client={client} locale={locale} signedOut={signedOut} pageSize={pageSize} />
        </TabsContent>
      </Tabs>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogTitle>{t('admin.create')}</DialogTitle>
          <form className="flex flex-col gap-3" onSubmit={submitCreate}>
            <div className="flex flex-col gap-1">
              <Label htmlFor="admin-username">{t('admin.username')}</Label>
              <Input id="admin-username" name="username" required autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="admin-email">{t('admin.email')}</Label>
              <Input id="admin-email" name="email" type="email" required autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="admin-display-name">{t('admin.displayName')}</Label>
              <Input id="admin-display-name" name="displayName" required autoComplete="off" />
            </div>
            <Button type="submit">{t('admin.save')}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
