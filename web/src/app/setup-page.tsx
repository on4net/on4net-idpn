import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { Locale } from '@/i18n';
import { useTranslate } from '@/i18n/translation-context';

export type SetupStatus = 'open' | 'installed' | 'error';

export type SetupError =
  'network' | 'rate_limited' | 'invalid_token' | 'password_policy' | 'exists' | 'closed' | 'server';

export type SetupResult =
  { ok: true } | { ok: false; error: SetupError; violations?: readonly string[] };

export interface SetupAdminValues {
  token: string;
  displayName: string;
  username: string;
  email: string;
  password: string;
  adminUrl?: string;
}

export interface SetupPageProps {
  locale: Locale;
  /** Where "back to sign in" points; the Hosted UI passes `?` plus its client params. */
  backHref?: string;
  /** `GET /api/v1/setup/status`; injectable for tests. */
  loadStatus(): Promise<SetupStatus>;
  /** `POST /api/v1/setup/verify`; injectable for tests. */
  verifyToken(token: string): Promise<SetupResult>;
  /** `POST /api/v1/setup/complete`; injectable for tests. */
  complete(values: SetupAdminValues): Promise<SetupResult>;
}

type Step = 'loading' | 'token' | 'admin' | 'done' | 'installed' | 'unavailable';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

const errorKey = (error: SetupError): string => {
  switch (error) {
    case 'network':
      return 'account.flow.errorNetwork';
    case 'rate_limited':
      return 'account.flow.errorRateLimited';
    case 'invalid_token':
      return 'setup.errorInvalidToken';
    case 'exists':
      return 'setup.errorExists';
    case 'closed':
      return 'setup.installedBody';
    default:
      return 'account.flow.errorGeneric';
  }
};

/** Returns the origin of an http(s) URL, or `null` when the value cannot be used. */
function adminOriginOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function SetupCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <main className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-xl font-semibold text-foreground">{title}</h1>
      {subtitle === undefined ? null : (
        <p className="mb-6 text-sm text-muted-foreground">{subtitle}</p>
      )}
      {children}
    </main>
  );
}

function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help === undefined ? null : (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * First-run install wizard (`?action=setup`). Step 1 proves possession of the one-time setup
 * token printed by the API, step 2 creates the first administrator. The token and the
 * password live in component memory only; once the instance is installed the wizard shows a
 * closed notice and never renders the form again (the API answers 404 for the write calls).
 */
export function SetupPage({
  locale,
  backHref = '?',
  loadStatus,
  verifyToken,
  complete,
}: SetupPageProps): React.ReactElement {
  const t = useTranslate(locale);
  const [step, setStep] = React.useState<Step>('loading');
  const [token, setToken] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [adminUrl, setAdminUrl] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<SetupError | null>(null);
  const [violations, setViolations] = React.useState<readonly string[]>([]);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [doneUrl, setDoneUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void loadStatus()
      .then((status) => {
        if (!cancelled) {
          setStep(
            status === 'open' ? 'token' : status === 'installed' ? 'installed' : 'unavailable',
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStep('unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  /** A `closed` answer means another request finished the install: stop offering the form. */
  const fail = (result: Extract<SetupResult, { ok: false }>): void => {
    if (result.error === 'closed') {
      setToken('');
      setPassword('');
      setConfirmation('');
      setStep('installed');
      return;
    }
    setError(result.error);
    setViolations(result.violations ?? []);
  };

  const submitToken = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (token.trim() === '') {
      setFieldErrors({ token: 'setup.required' });
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      const result = await verifyToken(token.trim());
      if (result.ok) {
        setStep('admin');
        return;
      }
      fail(result);
    } finally {
      setSubmitting(false);
    }
  };

  const submitAdmin = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setViolations([]);
    const errors: Record<string, string> = {};
    if (displayName.trim() === '') {
      errors.displayName = 'setup.required';
    }
    if (!USERNAME_PATTERN.test(username.trim())) {
      errors.username = 'setup.usernameInvalid';
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      errors.email = 'account.flow.emailInvalid';
    }
    const length = Array.from(password).length;
    if (length < 12) {
      errors.password = 'account.flow.tooShort';
    } else if (length > 128) {
      errors.password = 'account.flow.tooLong';
    }
    if (confirmation !== password) {
      errors.confirmation = 'account.flow.mismatch';
    }
    const origin = adminUrl.trim() === '' ? undefined : adminOriginOf(adminUrl.trim());
    if (adminUrl.trim() !== '' && origin === null) {
      errors.adminUrl = 'setup.adminUrlInvalid';
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await complete({
        token: token.trim(),
        displayName: displayName.trim(),
        username: username.trim(),
        email: email.trim(),
        password,
        ...(origin === undefined || origin === null ? {} : { adminUrl: origin }),
      });
      if (result.ok) {
        setToken('');
        setPassword('');
        setConfirmation('');
        setDoneUrl(origin ?? null);
        setStep('done');
        return;
      }
      if (result.error === 'invalid_token') {
        // The token is checked first by the API; send the operator back to re-enter it.
        setStep('token');
      }
      fail(result);
    } finally {
      setSubmitting(false);
    }
  };

  const errorAlert =
    error === null ? null : (
      <Alert variant="destructive" data-testid="setup-error" aria-live="assertive">
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
    );

  const submitLabel = (idle: string): React.ReactElement => (
    <>
      {submitting ? <Spinner label={t('common.loading')} /> : null}
      <span>{submitting ? t('account.flow.submitting') : idle}</span>
    </>
  );

  if (step === 'loading') {
    return (
      <SetupCard title={t('setup.title')}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label={t('common.loading')} />
          <span role="status">{t('common.loading')}</span>
        </div>
      </SetupCard>
    );
  }

  if (step === 'unavailable') {
    return (
      <SetupCard title={t('setup.title')}>
        <Alert variant="destructive" data-testid="setup-unavailable">
          <AlertTitle>{t('account.flow.errorTitle')}</AlertTitle>
          <AlertDescription>{t('account.flow.errorNetwork')}</AlertDescription>
        </Alert>
      </SetupCard>
    );
  }

  if (step === 'installed') {
    return (
      <SetupCard title={t('setup.installedTitle')}>
        <Alert data-testid="setup-installed" aria-live="polite">
          <AlertTitle>{t('setup.installedTitle')}</AlertTitle>
          <AlertDescription>{t('setup.installedBody')}</AlertDescription>
        </Alert>
        <p className="mt-4 text-sm">
          <a href={backHref} className="text-primary underline-offset-4 hover:underline">
            {t('account.flow.backToLogin')}
          </a>
        </p>
      </SetupCard>
    );
  }

  if (step === 'done') {
    return (
      <SetupCard title={t('setup.doneTitle')}>
        <Alert data-testid="setup-done" aria-live="polite">
          <AlertTitle>{t('setup.doneTitle')}</AlertTitle>
          <AlertDescription>{t('setup.doneBody')}</AlertDescription>
        </Alert>
        <p className="mt-4 text-sm">
          <a href={doneUrl ?? backHref} className="text-primary underline-offset-4 hover:underline">
            {t('setup.goToSignIn')}
          </a>
        </p>
      </SetupCard>
    );
  }

  if (step === 'token') {
    return (
      <SetupCard title={t('setup.title')} subtitle={t('setup.tokenSubtitle')}>
        <form className="grid gap-4" noValidate onSubmit={(event) => void submitToken(event)}>
          {errorAlert}
          <Field
            id="setup-token"
            label={t('setup.tokenLabel')}
            help={t('setup.tokenHelp')}
            error={fieldErrors.token === undefined ? undefined : t(fieldErrors.token)}
          >
            <Input
              id="setup-token"
              type="password"
              autoComplete="off"
              autoFocus
              dir="ltr"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              aria-invalid={fieldErrors.token === undefined ? undefined : true}
            />
          </Field>
          <Button type="submit" disabled={submitting} className="gap-2">
            {submitLabel(t('setup.tokenContinue'))}
          </Button>
        </form>
      </SetupCard>
    );
  }

  const fieldError = (name: string): string | undefined =>
    fieldErrors[name] === undefined ? undefined : t(fieldErrors[name]);

  return (
    <SetupCard title={t('setup.adminTitle')} subtitle={t('setup.adminSubtitle')}>
      <form className="grid gap-4" noValidate onSubmit={(event) => void submitAdmin(event)}>
        {errorAlert}
        <Field
          id="setup-display-name"
          label={t('setup.displayName')}
          error={fieldError('displayName')}
        >
          <Input
            id="setup-display-name"
            autoComplete="name"
            autoFocus
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={fieldErrors.displayName === undefined ? undefined : true}
          />
        </Field>
        <Field
          id="setup-username"
          label={t('setup.username')}
          help={t('setup.usernameHelp')}
          error={fieldError('username')}
        >
          <Input
            id="setup-username"
            autoComplete="username"
            dir="ltr"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={fieldErrors.username === undefined ? undefined : true}
          />
        </Field>
        <Field id="setup-email" label={t('setup.email')} error={fieldError('email')}>
          <Input
            id="setup-email"
            type="email"
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={fieldErrors.email === undefined ? undefined : true}
          />
        </Field>
        <Field
          id="setup-password"
          label={t('account.flow.newPassword')}
          help={t('account.password.policy')}
          error={fieldError('password')}
        >
          <Input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldErrors.password === undefined ? undefined : true}
          />
        </Field>
        <Field
          id="setup-confirm"
          label={t('account.flow.confirmPassword')}
          error={fieldError('confirmation')}
        >
          <Input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            aria-invalid={fieldErrors.confirmation === undefined ? undefined : true}
          />
        </Field>
        <Field
          id="setup-admin-url"
          label={t('setup.adminUrl')}
          help={t('setup.adminUrlHelp')}
          error={fieldError('adminUrl')}
        >
          <Input
            id="setup-admin-url"
            type="url"
            autoComplete="off"
            dir="ltr"
            value={adminUrl}
            onChange={(event) => setAdminUrl(event.target.value)}
            aria-invalid={fieldErrors.adminUrl === undefined ? undefined : true}
          />
        </Field>
        <Button type="submit" disabled={submitting} className="gap-2">
          {submitLabel(t('setup.submit'))}
        </Button>
      </form>
    </SetupCard>
  );
}
