import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { Locale } from '@/i18n';
import { useTranslate } from '@/i18n/translation-context';

export interface LoginFormValues {
  identifier: string;
  password: string;
}

export interface LoginFormProps {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  submitting: boolean;
  errorCode: 'invalid_credentials' | 'network' | 'mfa_enrollment_required' | null;
  /** Prefills the identifier from `login_hint`; the user may still change it. */
  defaultIdentifier?: string;
  /** Forgot-password link target; the Hosted UI keeps its client parameters in it. */
  forgotHref?: string;
  /** Optional social login block rendered above the password form, inside the same card. */
  social?: React.ReactNode;
  onSubmit(values: LoginFormValues): void | Promise<void>;
}

export function LoginForm({
  locale,
  dir,
  submitting,
  errorCode,
  defaultIdentifier,
  forgotHref = '/forgot-password',
  social,
  onSubmit,
}: LoginFormProps) {
  const t = useTranslate(locale);

  const schema = z.object({
    identifier: z.string().trim().min(1, t('login.errorRequired')),
    password: z.string().min(1, t('login.errorPasswordRequired')),
  });

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: defaultIdentifier ?? '', password: '' },
    shouldFocusError: true,
  });

  const errorMessage =
    errorCode === 'invalid_credentials'
      ? t('login.errorInvalid')
      : errorCode === 'network'
        ? t('login.errorNetwork')
        : errorCode === 'mfa_enrollment_required'
          ? t('mfa.enrollmentRequired')
          : null;

  return (
    <main
      dir={dir}
      className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-start shadow-sm"
    >
      <h1 className="mb-1 text-xl font-semibold text-foreground">{t('login.title')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('login.subtitle')}</p>

      {social === undefined ? null : <div className="mb-4">{social}</div>}

      {errorMessage === null ? null : (
        <Alert variant="destructive" className="mb-4" aria-live="assertive">
          <AlertTitle>{t('login.errorSummary')}</AlertTitle>
          <AlertDescription id="login-error">{errorMessage}</AlertDescription>
        </Alert>
      )}

      <form
        className="grid gap-4"
        noValidate
        onSubmit={handleSubmit((values) => {
          void onSubmit(values);
          setFocus('identifier');
        })}
        aria-describedby={errorMessage === null ? undefined : 'login-error'}
      >
        <div className="grid gap-2">
          <Label htmlFor="identifier">{t('login.identifier')}</Label>
          <Input
            id="identifier"
            type="text"
            dir="auto"
            autoComplete="username"
            autoFocus
            aria-invalid={errors.identifier ? true : undefined}
            aria-describedby={errors.identifier ? 'identifier-error' : undefined}
            {...register('identifier')}
          />
          {errors.identifier ? (
            <p id="identifier-error" role="alert" className="text-xs text-destructive">
              {errors.identifier.message}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password">{t('login.password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...register('password')}
          />
          {errors.password ? (
            <p id="password-error" role="alert" className="text-xs text-destructive">
              {errors.password.message}
            </p>
          ) : null}
        </div>

        <Button type="submit" disabled={submitting} className="gap-2">
          {submitting ? <Spinner label={t('common.loading')} /> : null}
          <span>{submitting ? t('login.submitting') : t('login.submit')}</span>
        </Button>
      </form>

      <p className="mt-4 text-sm">
        <a href={forgotHref} className="text-primary underline-offset-4 hover:underline">
          {t('login.forgot')}
        </a>
      </p>
    </main>
  );
}
