import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { Locale } from '@/i18n';
import { useTranslate } from '@/i18n/translation-context';

export type AccountFlowError =
  'network' | 'rate_limited' | 'invalid_token' | 'password_policy' | 'server';

export type AccountFlowResult =
  { ok: true } | { ok: false; error: AccountFlowError; violations?: readonly string[] };

export type SetPasswordMode = 'invite' | 'reset';

export interface ForgotPasswordPageProps {
  locale: Locale;
  /** Where the "back" link points; the Hosted UI passes `?` plus its client params. */
  backHref?: string;
  /** Injected for tests; defaults call the public forgot endpoint. */
  onSubmit(email: string): Promise<AccountFlowResult>;
}

const errorKey = (error: AccountFlowError): string =>
  error === 'network'
    ? 'account.flow.errorNetwork'
    : error === 'rate_limited'
      ? 'account.flow.errorRateLimited'
      : error === 'invalid_token'
        ? 'account.flow.errorInvalidToken'
        : 'account.flow.errorGeneric';

function FlowCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <main className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-xl font-semibold text-foreground">{title}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{subtitle}</p>
      {children}
    </main>
  );
}

/**
 * Request a reset link. The confirmation is intentionally identical whether or not the
 * address exists (anti-enumeration, docs/security.md T13).
 */
export function ForgotPasswordPage({
  locale,
  backHref = '?',
  onSubmit,
}: ForgotPasswordPageProps): React.ReactElement {
  const t = useTranslate(locale);
  const [email, setEmail] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<AccountFlowError | null>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFieldError('account.flow.emailInvalid');
      return;
    }
    setSubmitting(true);
    try {
      const result = await onSubmit(email.trim());
      if (result.ok) {
        setSent(true);
        return;
      }
      setError(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FlowCard title={t('account.flow.forgotTitle')} subtitle={t('account.flow.forgotSubtitle')}>
      {sent ? (
        <Alert data-testid="forgot-sent" aria-live="polite">
          <AlertTitle>{t('account.flow.forgotTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.forgotSent')}</AlertDescription>
        </Alert>
      ) : (
        <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <Alert variant="destructive" aria-live="assertive">
              <AlertTitle>{t('account.flow.errorTitle')}</AlertTitle>
              <AlertDescription>{t(errorKey(error))}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="forgot-email">{t('login.identifier')}</Label>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              autoFocus
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={fieldError === null ? undefined : true}
              aria-describedby={fieldError === null ? undefined : 'forgot-email-error'}
            />
            {fieldError === null ? null : (
              <p id="forgot-email-error" role="alert" className="text-xs text-destructive">
                {t(fieldError)}
              </p>
            )}
          </div>
          <Button type="submit" disabled={submitting} className="gap-2">
            {submitting ? <Spinner label={t('common.loading')} /> : null}
            <span>
              {submitting ? t('account.flow.submitting') : t('account.flow.forgotSubmit')}
            </span>
          </Button>
        </form>
      )}
      <p className="mt-4 text-sm">
        <a href={backHref} className="text-primary underline-offset-4 hover:underline">
          {t('account.flow.backToLogin')}
        </a>
      </p>
    </FlowCard>
  );
}

/** First password (invite) or new password (reset) form; the token is never rendered. */
export function SetPasswordPage({
  locale,
  mode,
  token,
  backHref = '?',
  onSubmit,
}: {
  locale: Locale;
  mode: SetPasswordMode;
  token: string | undefined;
  backHref?: string;
  onSubmit(input: {
    token: string;
    password: string;
    mode: SetPasswordMode;
  }): Promise<AccountFlowResult>;
}): React.ReactElement {
  const t = useTranslate(locale);
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<AccountFlowError | null>(null);
  const [violations, setViolations] = React.useState<readonly string[]>([]);
  const [fieldErrors, setFieldErrors] = React.useState<{
    password?: string;
    confirmation?: string;
  }>({});

  const invalid = token === undefined || token === '';

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (invalid) {
      return;
    }
    setError(null);
    setViolations([]);
    const errors: { password?: string; confirmation?: string } = {};
    if (Array.from(password).length < 12) {
      errors.password = 'account.flow.tooShort';
    } else if (Array.from(password).length > 128) {
      errors.password = 'account.flow.tooLong';
    }
    if (confirmation !== password) {
      errors.confirmation = 'account.flow.mismatch';
    }
    setFieldErrors(errors);
    if (errors.password !== undefined || errors.confirmation !== undefined) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await onSubmit({ token, password, mode });
      if (result.ok) {
        setDone(true);
        return;
      }
      setError(result.error);
      if (result.violations !== undefined) {
        setViolations(result.violations);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title = mode === 'invite' ? t('account.flow.inviteTitle') : t('account.flow.resetTitle');
  const subtitle =
    mode === 'invite' ? t('account.flow.inviteSubtitle') : t('account.flow.resetSubtitle');

  return (
    <FlowCard title={title} subtitle={subtitle}>
      {done ? (
        <Alert data-testid="password-done" aria-live="polite">
          <AlertTitle>{t('account.flow.passwordDoneTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.passwordDone')}</AlertDescription>
        </Alert>
      ) : invalid ? (
        <Alert variant="destructive" data-testid="password-invalid-token">
          <AlertTitle>{t('account.flow.errorTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.errorInvalidToken')}</AlertDescription>
        </Alert>
      ) : (
        <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <Alert variant="destructive" data-testid="password-flow-error" aria-live="assertive">
              <AlertTitle>{t('account.flow.errorTitle')}</AlertTitle>
              <AlertDescription>
                {error === 'password_policy' ? (
                  <ul className="list-disc ps-5">
                    {(violations.length === 0 ? ['too_short'] : violations).map((violation) => (
                      <li key={violation}>{t(`account.password.${violation}`)}</li>
                    ))}
                  </ul>
                ) : (
                  t(errorKey(error))
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="set-password-new">{t('account.flow.newPassword')}</Label>
            <Input
              id="set-password-new"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldErrors.password === undefined ? undefined : true}
              aria-describedby={
                fieldErrors.password === undefined
                  ? 'set-password-policy'
                  : 'set-password-new-error'
              }
            />
            <p id="set-password-policy" className="text-xs text-muted-foreground">
              {t('account.password.policy')}
            </p>
            {fieldErrors.password === undefined ? null : (
              <p id="set-password-new-error" role="alert" className="text-xs text-destructive">
                {t(fieldErrors.password)}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="set-password-confirm">{t('account.flow.confirmPassword')}</Label>
            <Input
              id="set-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={fieldErrors.confirmation === undefined ? undefined : true}
              aria-describedby={
                fieldErrors.confirmation === undefined ? undefined : 'set-password-confirm-error'
              }
            />
            {fieldErrors.confirmation === undefined ? null : (
              <p id="set-password-confirm-error" role="alert" className="text-xs text-destructive">
                {t(fieldErrors.confirmation)}
              </p>
            )}
          </div>

          <Button type="submit" disabled={submitting} className="gap-2">
            {submitting ? <Spinner label={t('common.loading')} /> : null}
            <span>{submitting ? t('account.flow.submitting') : t('account.flow.setPassword')}</span>
          </Button>
        </form>
      )}
      <p className="mt-4 text-sm">
        <a href={backHref} className="text-primary underline-offset-4 hover:underline">
          {t('account.flow.backToLogin')}
        </a>
      </p>
    </FlowCard>
  );
}

/** Confirms an email-verification link once on mount. Safe states never expose the token. */
export function VerifyEmailPage({
  locale,
  token,
  backHref = '?',
  onConfirm,
}: {
  locale: Locale;
  token: string | undefined;
  backHref?: string;
  onConfirm(token: string): Promise<AccountFlowResult>;
}): React.ReactElement {
  const t = useTranslate(locale);
  const started = React.useRef(false);
  const [status, setStatus] = React.useState<'checking' | 'done' | 'invalid' | 'error'>(
    token === undefined || token === '' ? 'invalid' : 'checking',
  );

  React.useEffect(() => {
    if (token === undefined || token === '' || started.current) {
      return;
    }
    // StrictMode runs effects twice in development; a single-use token must only be sent
    // once, and the in-flight promise still updates this component after the remount.
    started.current = true;
    void onConfirm(token)
      .then((result) => {
        setStatus(result.ok ? 'done' : result.error === 'invalid_token' ? 'invalid' : 'error');
      })
      .catch(() => {
        setStatus('error');
      });
  }, [onConfirm, token]);

  return (
    <FlowCard title={t('account.flow.verifyTitle')} subtitle={t('account.flow.verifySubtitle')}>
      {status === 'checking' ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label={t('common.loading')} />
          <span role="status">{t('common.loading')}</span>
        </div>
      ) : null}
      {status === 'done' ? (
        <Alert data-testid="verify-done" aria-live="polite">
          <AlertTitle>{t('account.flow.verifyDoneTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.verifyDone')}</AlertDescription>
        </Alert>
      ) : null}
      {status === 'invalid' ? (
        <Alert variant="destructive" data-testid="verify-invalid">
          <AlertTitle>{t('account.flow.errorTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.errorInvalidToken')}</AlertDescription>
        </Alert>
      ) : null}
      {status === 'error' ? (
        <Alert variant="destructive" data-testid="verify-error">
          <AlertTitle>{t('account.flow.errorTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.errorNetwork')}</AlertDescription>
        </Alert>
      ) : null}
      <p className="mt-4 text-sm">
        <a href={backHref} className="text-primary underline-offset-4 hover:underline">
          {t('account.flow.backToLogin')}
        </a>
      </p>
    </FlowCard>
  );
}
