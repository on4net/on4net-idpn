import * as React from 'react';

import { IdpnRoot } from '@/app/idpn-root';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { directionOf, resolveLocale, translate, type Locale } from '@/i18n';
import {
  AccountApiError,
  createAccountApiClient,
  type AccountApiClient,
  type AccountProfile,
  type AccountSession,
} from './account-api-client';
import { MfaSection } from './mfa-section';
import type { PasskeyDriver } from './passkey-client';

export interface AccountEvent {
  type: 'auth:error';
  code: string;
}

export interface AccountProps {
  /** Same-origin by default; the hosted/embedded account UI lives on the IdP origin. */
  apiBaseUrl?: string;
  locale?: string;
  dir?: 'rtl' | 'ltr';
  /** Host configuration only; used for diagnostics, never for authorization. */
  clientId?: string;
  /** Receives non-sensitive module events; never contains a token. */
  onEvent?: (event: AccountEvent) => void;
  /** Test seam; production hosts use the configured client. */
  apiClient?: AccountApiClient;
  /** WebAuthn browser implementation; injectable so tests never prompt a real authenticator. */
  passkeys?: PasskeyDriver;
}

interface FieldErrors {
  current?: string;
  next?: string;
}

const CURRENT_ID = 'account-current-password';
const NEW_ID = 'account-new-password';
const POLICY_ID = 'account-password-policy';

const describeError = (error: unknown): string => {
  if (error instanceof AccountApiError) {
    if (error.kind === 'unauthorized') return 'account.errorUnauthorized';
    if (error.kind === 'forbidden') return 'account.errorForbidden';
    if (error.kind === 'network') return 'account.errorNetwork';
  }
  return 'account.errorGeneric';
};

const isAbort = (error: unknown): boolean =>
  typeof DOMException !== 'undefined' &&
  error instanceof DOMException &&
  error.name === 'AbortError';

/**
 * `account` micro-frontend module (docs/micro-frontend.md 3).
 *
 * Renders the signed-in user's profile, password change, active sessions and MFA. The
 * same-origin IdP session cookie authenticates every call, so no token is read, stored or
 * emitted.
 */
export function Account({
  apiBaseUrl,
  locale = 'fa-IR',
  dir,
  clientId,
  onEvent,
  apiClient,
  passkeys,
}: AccountProps) {
  const activeLocale: Locale = resolveLocale(locale);
  const direction = dir ?? directionOf(activeLocale);
  const t = React.useCallback(
    (key: string, values: Record<string, string | number> = {}) =>
      translate(activeLocale, key, values),
    [activeLocale],
  );
  const api = React.useMemo(
    () =>
      apiClient ??
      createAccountApiClient({
        ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }),
      }),
    [apiClient, apiBaseUrl],
  );
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium', timeStyle: 'short' }),
    [activeLocale],
  );

  const [profile, setProfile] = React.useState<AccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = React.useState(true);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [profileReload, setProfileReload] = React.useState(0);

  const [sessions, setSessions] = React.useState<AccountSession[]>([]);
  const [sessionTotal, setSessionTotal] = React.useState(0);
  const [sessionsLoading, setSessionsLoading] = React.useState(true);
  const [sessionsError, setSessionsError] = React.useState<string | null>(null);
  const [sessionsReload, setSessionsReload] = React.useState(0);
  const [closingId, setClosingId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = React.useState<string | null>(null);
  const [verificationError, setVerificationError] = React.useState<string | null>(null);
  const [resendingVerification, setResendingVerification] = React.useState(false);

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [policyViolations, setPolicyViolations] = React.useState<readonly string[]>([]);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const report = React.useCallback(
    (caught: unknown): string => {
      if (caught instanceof AccountApiError) {
        onEvent?.({ type: 'auth:error', code: caught.code ?? caught.kind });
      }
      return describeError(caught);
    },
    [onEvent],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setProfileLoading(true);
    setProfileError(null);

    api
      .getProfile({ signal: controller.signal })
      .then((result) => {
        if (active) {
          setProfile(result);
        }
      })
      .catch((caught: unknown) => {
        if (active && !isAbort(caught)) {
          setProfileError(report(caught));
        }
      })
      .finally(() => {
        if (active) {
          setProfileLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [api, profileReload, report]);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSessionsLoading(true);
    setSessionsError(null);

    api
      .listSessions({ page: 1, limit: 25 }, { signal: controller.signal })
      .then((result) => {
        if (active) {
          setSessions(result.items);
          setSessionTotal(result.total);
        }
      })
      .catch((caught: unknown) => {
        if (active && !isAbort(caught)) {
          setSessionsError(report(caught));
        }
      })
      .finally(() => {
        if (active) {
          setSessionsLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [api, sessionsReload, report]);

  const submitPassword = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSuccess(null);
    setFormError(null);
    setPolicyViolations([]);

    const errors: FieldErrors = {};
    if (currentPassword === '') {
      errors.current = 'account.password.currentRequired';
    }
    if (newPassword === '') {
      errors.next = 'account.password.newRequired';
    } else if (Array.from(newPassword).length < 12) {
      errors.next = 'account.password.too_short';
    } else if (Array.from(newPassword).length > 128) {
      errors.next = 'account.password.too_long';
    }
    setFieldErrors(errors);
    if (errors.current !== undefined || errors.next !== undefined) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setFieldErrors({});
      setSuccess(t('account.password.success', { count: result.revokedSessions }));
      setSessionsReload((value) => value + 1);
    } catch (caught) {
      if (caught instanceof AccountApiError) {
        onEvent?.({ type: 'auth:error', code: caught.code ?? caught.kind });
        if (caught.code === 'invalid_current_password') {
          setFieldErrors({ current: 'account.password.invalidCurrent' });
        } else if (caught.code === 'password_policy') {
          if (caught.violations.length > 0) {
            setPolicyViolations(caught.violations);
          } else {
            setFormError('account.password.errorGeneric');
          }
        } else if (caught.code === 'password_reuse') {
          setFormError('account.password.reuse');
        } else {
          setFormError(describeError(caught));
        }
      } else {
        setFormError('account.password.errorGeneric');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const resendVerification = async (): Promise<void> => {
    setResendingVerification(true);
    setVerificationNotice(null);
    setVerificationError(null);
    try {
      const result = await api.resendVerification();
      setVerificationNotice(
        result.status === 'already_verified'
          ? 'account.emailVerification.already'
          : 'account.emailVerification.sent',
      );
      if (result.status === 'already_verified') {
        setProfileReload((value) => value + 1);
      }
    } catch (caught) {
      if (caught instanceof AccountApiError) {
        onEvent?.({ type: 'auth:error', code: caught.code ?? caught.kind });
      }
      setVerificationError('account.emailVerification.error');
    } finally {
      setResendingVerification(false);
    }
  };

  const closeSession = async (sid: string): Promise<void> => {
    setClosingId(sid);
    setSessionsError(null);
    setNotice(null);
    try {
      await api.closeSession(sid);
      setSessions((items) => items.filter((item) => item.id !== sid));
      setSessionTotal((total) => Math.max(0, total - 1));
      setNotice(t('account.sessions.closed'));
    } catch (caught) {
      if (caught instanceof AccountApiError && caught.code === 'current_session') {
        onEvent?.({ type: 'auth:error', code: caught.code });
        setSessionsError(t('account.sessions.currentLocked'));
      } else {
        setSessionsError(report(caught));
      }
    } finally {
      setClosingId(null);
    }
  };

  const formatDate = (value: string | null): string =>
    value === null ? t('account.none') : dateFormatter.format(new Date(value));

  return (
    <section
      className="mx-auto grid w-full max-w-3xl gap-4 text-start"
      dir={direction}
      data-testid="account-module"
      {...(clientId === undefined ? {} : { 'data-client-id': clientId })}
    >
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('account.title')}</h1>
      </header>

      {profileLoading && profile === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label={t('account.loading')} />
          <span>{t('account.loading')}</span>
        </div>
      ) : null}

      {profileError !== null && profile === null ? (
        <Alert variant="destructive" data-testid="account-error">
          <AlertTitle>{t('account.errorTitle')}</AlertTitle>
          <AlertDescription>{t(profileError)}</AlertDescription>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            onClick={() => setProfileReload((value) => value + 1)}
          >
            {t('account.retry')}
          </Button>
        </Alert>
      ) : null}

      {profile !== null ? (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold leading-none">{t('account.profile.title')}</h2>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t('account.profile.displayName')}</dt>
                <dd>{profile.displayName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.username')}</dt>
                <dd>{profile.username}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.email')}</dt>
                <dd>{profile.email}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.phone')}</dt>
                <dd>{profile.phone ?? t('account.none')}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.locale')}</dt>
                <dd>{profile.locale}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.status')}</dt>
                <dd>
                  <Badge variant={profile.status === 'active' ? 'default' : 'outline'}>
                    {t(`account.status.${profile.status}`)}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.emailVerified')}</dt>
                <dd>
                  {profile.emailVerified ? (
                    t('account.yes')
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{t('account.emailVerification.unverified')}</Badge>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={resendingVerification}
                        onClick={() => void resendVerification()}
                      >
                        {resendingVerification
                          ? t('account.emailVerification.resending')
                          : t('account.emailVerification.resend')}
                      </Button>
                    </div>
                  )}
                  {verificationNotice === null ? null : (
                    <p role="status" className="mt-1 text-xs text-muted-foreground">
                      {t(verificationNotice)}
                    </p>
                  )}
                  {verificationError === null ? null : (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {t(verificationError)}
                    </p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('account.profile.createdAt')}</dt>
                <dd>{formatDate(profile.createdAt)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {profile !== null ? (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold leading-none">{t('account.password.title')}</h2>
            <CardDescription>{t('account.password.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(event) => void submitPassword(event)}
            >
              {success !== null ? (
                <Alert data-testid="password-success">
                  <AlertTitle>{t('account.password.title')}</AlertTitle>
                  <AlertDescription>{success}</AlertDescription>
                </Alert>
              ) : null}

              {formError !== null || policyViolations.length > 0 ? (
                <Alert variant="destructive" data-testid="password-error">
                  <AlertTitle>{t('account.password.errorTitle')}</AlertTitle>
                  <AlertDescription>
                    {formError !== null ? <p>{t(formError)}</p> : null}
                    {policyViolations.length > 0 ? (
                      <ul className="list-disc ps-5">
                        {policyViolations.map((violation) => (
                          <li key={violation}>{t(`account.password.${violation}`)}</li>
                        ))}
                      </ul>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-2">
                <Label htmlFor={CURRENT_ID}>{t('account.password.current')}</Label>
                <Input
                  id={CURRENT_ID}
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  aria-invalid={fieldErrors.current === undefined ? undefined : true}
                  aria-describedby={
                    fieldErrors.current === undefined ? undefined : `${CURRENT_ID}-error`
                  }
                />
                {fieldErrors.current !== undefined ? (
                  <p id={`${CURRENT_ID}-error`} role="alert" className="text-xs text-destructive">
                    {t(fieldErrors.current)}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label htmlFor={NEW_ID}>{t('account.password.new')}</Label>
                <Input
                  id={NEW_ID}
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  aria-invalid={fieldErrors.next === undefined ? undefined : true}
                  aria-describedby={
                    fieldErrors.next === undefined ? POLICY_ID : `${POLICY_ID} ${NEW_ID}-error`
                  }
                />
                <p id={POLICY_ID} className="text-xs text-muted-foreground">
                  {t('account.password.policy')}
                </p>
                {fieldErrors.next !== undefined ? (
                  <p id={`${NEW_ID}-error`} role="alert" className="text-xs text-destructive">
                    {t(fieldErrors.next)}
                  </p>
                ) : null}
              </div>

              <div>
                <Button type="submit" disabled={submitting}>
                  {submitting ? t('account.password.submitting') : t('account.password.submit')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold leading-none">{t('account.sessions.title')}</h2>
          <CardDescription>{t('account.sessions.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {sessionsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner label={t('account.loading')} />
              <span>{t('account.loading')}</span>
            </div>
          ) : null}

          {sessionsError !== null ? (
            <Alert variant="destructive" data-testid="sessions-error">
              <AlertTitle>{t('account.sessions.errorTitle')}</AlertTitle>
              <AlertDescription>{t(sessionsError)}</AlertDescription>
            </Alert>
          ) : null}

          {notice !== null ? (
            <p role="status" className="mb-3 text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}

          {!sessionsLoading && sessionsError === null && sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('account.sessions.empty')}</p>
          ) : null}

          {sessions.length > 0 ? (
            <Table>
              <TableCaption>{t('account.sessions.description')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('account.sessions.columnClient')}</TableHead>
                  <TableHead>{t('account.sessions.columnCreated')}</TableHead>
                  <TableHead>{t('account.sessions.columnLastSeen')}</TableHead>
                  <TableHead>{t('account.sessions.columnAddress')}</TableHead>
                  <TableHead>{t('account.sessions.columnAction')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id} data-testid={`session-${session.id}`}>
                    <TableCell>{session.clientId ?? t('account.none')}</TableCell>
                    <TableCell>{formatDate(session.createdAt)}</TableCell>
                    <TableCell>{formatDate(session.lastSeenAt)}</TableCell>
                    <TableCell>
                      {session.ip ?? t('account.none')} · {session.userAgent ?? t('account.none')}
                    </TableCell>
                    <TableCell>
                      {session.current ? (
                        <Badge variant="secondary">{t('account.sessions.current')}</Badge>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={closingId !== null}
                          aria-label={t('account.sessions.closeFor', { id: session.id })}
                          onClick={() => void closeSession(session.id)}
                        >
                          {closingId === session.id
                            ? t('account.sessions.closing')
                            : t('account.sessions.close')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            {t('account.sessions.currentLocked')} ({sessionTotal})
          </p>
        </CardContent>
      </Card>

      <MfaSection
        api={api}
        locale={activeLocale}
        t={t}
        onEvent={onEvent}
        {...(passkeys === undefined ? {} : { passkeys })}
      />
    </section>
  );
}

export type AccountRootProps = AccountProps;

/**
 * Self-contained entry point for hosts: owns `.idpn-root`, direction and portal container.
 */
export function AccountRoot({ locale = 'fa-IR', dir, ...props }: AccountRootProps) {
  const activeLocale: Locale = resolveLocale(locale);
  return (
    <IdpnRoot locale={activeLocale} dir={dir ?? directionOf(activeLocale)}>
      <Account {...props} locale={activeLocale} {...(dir === undefined ? {} : { dir })} />
    </IdpnRoot>
  );
}

export default AccountRoot;
