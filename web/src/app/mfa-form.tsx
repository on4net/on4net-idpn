import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { translate, type Locale } from '@/i18n';

export type MfaMethod = 'totp' | 'recovery';

/** Failure states the challenge step can show (docs/auth-flows.md 7.3). */
export type MfaErrorCode = 'invalid_code' | 'expired' | 'rate_limited' | 'network';

export interface MfaFormValues {
  code: string;
  method: MfaMethod;
}

export interface MfaFormProps {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  submitting: boolean;
  errorCode: MfaErrorCode | null;
  /** Returning to the password step discards the challenge in the parent. */
  onBack?: (() => void) | undefined;
  onSubmit(values: MfaFormValues): void | Promise<void>;
}

const CODE_ID = 'mfa-code';
const CODE_HINT_ID = 'mfa-code-hint';
const CODE_ERROR_ID = 'mfa-code-error';

const RECOVERY_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * Second-factor step of the Hosted Auth UI.
 *
 * The code field uses `autocomplete="one-time-code"` and `inputmode="numeric"` so mobile
 * browsers can offer the TOTP from the OS password manager. Numeric input is rendered LTR
 * even in the RTL layout. Errors are announced through `aria-live` and never include the
 * submitted code.
 */
export function MfaForm({ locale, dir, submitting, errorCode, onBack, onSubmit }: MfaFormProps) {
  const t = (key: string): string => translate(locale, key);
  const [method, setMethod] = React.useState<MfaMethod>('totp');
  const [code, setCode] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const errorMessage =
    errorCode === 'invalid_code'
      ? t('login.mfa.codeInvalid')
      : errorCode === 'expired'
        ? t('login.mfa.expired')
        : errorCode === 'rate_limited'
          ? t('login.mfa.rateLimited')
          : errorCode === 'network'
            ? t('login.mfa.network')
            : null;

  const switchMethod = (): void => {
    setMethod((current) => (current === 'totp' ? 'recovery' : 'totp'));
    setCode('');
    setFieldError(null);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed === '') {
      setFieldError(t('login.mfa.codeRequired'));
      return;
    }
    if (method === 'totp' && !/^\d{6}$/.test(trimmed)) {
      setFieldError(t('login.mfa.codeFormat'));
      return;
    }
    if (
      method === 'recovery' &&
      !RECOVERY_PATTERN.test(trimmed.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    ) {
      setFieldError(t('login.mfa.recoveryFormat'));
      return;
    }
    setFieldError(null);
    void onSubmit({ code: trimmed, method });
  };

  const describedBy = [
    fieldError === null ? null : CODE_ERROR_ID,
    method === 'recovery' ? CODE_HINT_ID : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <main className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-xl font-semibold text-foreground">{t('login.mfa.title')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('login.mfa.subtitle')}</p>

      {errorMessage === null ? null : (
        <Alert variant="destructive" className="mb-4" aria-live="assertive">
          <AlertTitle>{t('login.mfa.errorTitle')}</AlertTitle>
          <AlertDescription id="mfa-error">{errorMessage}</AlertDescription>
        </Alert>
      )}

      <form
        className="grid gap-4"
        noValidate
        dir={dir}
        onSubmit={submit}
        aria-describedby={errorMessage === null ? undefined : 'mfa-error'}
      >
        <div className="grid gap-2">
          <Label htmlFor={CODE_ID}>
            {method === 'totp' ? t('login.mfa.codeLabel') : t('login.mfa.recoveryLabel')}
          </Label>
          <Input
            id={CODE_ID}
            name="code"
            type="text"
            dir="ltr"
            autoFocus
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            pattern={method === 'totp' ? '[0-9]*' : undefined}
            maxLength={method === 'totp' ? 6 : 11}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={fieldError === null ? undefined : true}
            aria-describedby={describedBy === '' ? undefined : describedBy}
          />
          {method === 'recovery' ? (
            <p id={CODE_HINT_ID} className="text-xs text-muted-foreground">
              {t('login.mfa.recoveryHint')}
            </p>
          ) : null}
          {fieldError === null ? null : (
            <p id={CODE_ERROR_ID} role="alert" className="text-xs text-destructive">
              {fieldError}
            </p>
          )}
        </div>

        <Button type="submit" disabled={submitting} className="gap-2">
          {submitting ? <Spinner label={t('common.loading')} /> : null}
          <span>{submitting ? t('login.mfa.submitting') : t('login.mfa.submit')}</span>
        </Button>

        <Button type="button" variant="outline" onClick={switchMethod} disabled={submitting}>
          {method === 'totp' ? t('login.mfa.useRecovery') : t('login.mfa.useTotp')}
        </Button>

        {onBack === undefined ? null : (
          <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
            {t('login.mfa.back')}
          </Button>
        )}
      </form>
    </main>
  );
}
