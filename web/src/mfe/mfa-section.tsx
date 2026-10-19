import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { type Locale } from '@/i18n';
import {
  AccountApiError,
  type AccountApiClient,
  type AccountMfaFactor,
  type AccountMfaStatus,
  type TotpEnrollment,
} from './account-api-client';
import { browserPasskeyDriver, passkeysSupported, type PasskeyDriver } from './passkey-client';

const CODE_ID = 'mfa-enrollment-code';
const REGENERATE_PASSWORD_ID = 'mfa-regenerate-password';
const DISABLE_PASSWORD_ID = 'mfa-disable-password';
const DISABLE_CODE_ID = 'mfa-disable-code';
const PASSKEY_NAME_ID = 'mfa-passkey-name';

export interface MfaSectionEvent {
  type: 'auth:error';
  code: string;
}

export interface MfaSectionProps {
  api: AccountApiClient;
  locale: Locale;
  /** Translation helper owned by the parent so both sections share one locale. */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** Non-sensitive module event; never contains a code, secret or token. */
  onEvent?: ((event: MfaSectionEvent) => void) | undefined;
  /** Browser WebAuthn API; tests inject a fake driver instead of a real authenticator. */
  passkeys?: PasskeyDriver;
}

type Busy = 'enroll' | 'verify' | 'disable' | 'regenerate' | null;

const reasonOf = (caught: unknown): string => {
  if (caught instanceof AccountApiError) {
    if (caught.code === 'invalid_mfa_code') return 'account.mfa.errorInvalidCode';
    if (caught.code === 'invalid_current_password') return 'account.mfa.errorInvalidPassword';
    if (caught.code === 'totp_already_enrolled') return 'account.mfa.errorAlreadyEnrolled';
    if (caught.code === 'webauthn_credential_exists') return 'account.passkey.errorExists';
    if (caught.code === 'webauthn_unavailable') return 'account.mfa.errorUnavailable';
    if (caught.code === 'webauthn_origin_not_allowed') return 'account.passkey.failed';
    if (caught.code?.startsWith('webauthn_') === true) return 'account.passkey.failed';
    if (caught.code === 'mfa_unavailable') return 'account.mfa.errorUnavailable';
    if (caught.kind === 'network') return 'account.errorNetwork';
    if (caught.kind === 'unauthorized') return 'account.errorUnauthorized';
  }
  return 'account.mfa.errorTitle';
};

/**
 * MFA section of the `account` micro-frontend (docs/auth-flows.md 7.2, docs/micro-frontend.md 3).
 *
 * Enrolls TOTP, confirms it with a code, shows the recovery codes exactly once, rotates them
 * and disables the factor after a password or code proof. The secret and codes live only in
 * component state: they are never stored, logged or emitted through `onEvent`.
 */
export function MfaSection({ api, locale, t, onEvent, passkeys }: MfaSectionProps) {
  const driver = passkeys ?? browserPasskeyDriver;
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  const [status, setStatus] = React.useState<AccountMfaStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  const [busy, setBusy] = React.useState<Busy>(null);
  const [enrollment, setEnrollment] = React.useState<TotpEnrollment | null>(null);
  const [code, setCode] = React.useState('');
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [password, setPassword] = React.useState('');
  const [disablePassword, setDisablePassword] = React.useState('');
  const [disableCode, setDisableCode] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [passkeyName, setPasskeyName] = React.useState('');
  const [passkeyBusy, setPasskeyBusy] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setLoadError(null);
    api
      .getMfaStatus({ signal: controller.signal })
      .then((result) => {
        if (active) {
          setStatus(result);
        }
      })
      .catch((caught: unknown) => {
        if (active && (caught as { name?: string }).name !== 'AbortError') {
          setLoadError(reasonOf(caught));
          if (caught instanceof AccountApiError) {
            onEvent?.({ type: 'auth:error', code: caught.code ?? caught.kind });
          }
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, reload, onEvent]);

  const report = (caught: unknown): void => {
    if (caught instanceof AccountApiError) {
      onEvent?.({ type: 'auth:error', code: caught.code ?? caught.kind });
    }
    setFormError(reasonOf(caught));
  };

  const startEnrollment = async (): Promise<void> => {
    setBusy('enroll');
    setFormError(null);
    setNotice(null);
    setCodeError(null);
    try {
      setEnrollment(await api.enrollTotp());
      setCode('');
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(null);
    }
  };

  const confirmEnrollment = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (enrollment === null) {
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeError(t('account.mfa.errorCodeRequired'));
      return;
    }
    setBusy('verify');
    setFormError(null);
    setCodeError(null);
    try {
      const result = await api.verifyTotpEnrollment({
        factorId: enrollment.factorId,
        code: code.trim(),
      });
      setEnrollment(null);
      setCode('');
      setRecoveryCodes(result.recoveryCodes);
      setNotice(t('account.mfa.enrolled'));
      setReload((value) => value + 1);
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password === '') {
      setFormError(t('account.password.currentRequired'));
      return;
    }
    setBusy('regenerate');
    setFormError(null);
    setNotice(null);
    try {
      const result = await api.regenerateRecoveryCodes({ password });
      setPassword('');
      setRecoveryCodes(result.recoveryCodes);
      setNotice(t('account.mfa.codesRotated'));
      setReload((value) => value + 1);
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(null);
    }
  };

  const disable = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (disablePassword === '' && disableCode.trim() === '') {
      setFormError(t('account.mfa.disableDescription'));
      return;
    }
    setBusy('disable');
    setFormError(null);
    setNotice(null);
    try {
      await api.disableTotp({
        ...(disablePassword === '' ? {} : { password: disablePassword }),
        ...(disableCode.trim() === '' ? {} : { code: disableCode.trim() }),
      });
      setDisablePassword('');
      setDisableCode('');
      setRecoveryCodes(null);
      setNotice(t('account.mfa.disabled'));
      setReload((value) => value + 1);
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(null);
    }
  };

  const enrollPasskey = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    if (!passkeysSupported(driver)) {
      setFormError(t('account.passkey.unsupported'));
      return;
    }
    setPasskeyBusy('enroll');
    try {
      const ceremony = await api.beginPasskeyRegistration();
      const response = await driver.register(ceremony.options);
      await api.finishPasskeyRegistration({
        challengeId: ceremony.challengeId,
        response,
        ...(passkeyName.trim() === '' ? {} : { name: passkeyName.trim() }),
      });
      setPasskeyName('');
      setNotice(t('account.passkey.enrolled'));
      setReload((value) => value + 1);
    } catch (caught) {
      report(caught);
    } finally {
      setPasskeyBusy(null);
    }
  };

  const removePasskey = async (factor: AccountMfaFactor): Promise<void> => {
    setFormError(null);
    setNotice(null);
    setPasskeyBusy(`delete:${factor.id}`);
    try {
      await api.deletePasskey(factor.id);
      setNotice(t('account.passkey.deleted'));
      setReload((value) => value + 1);
    } catch (caught) {
      report(caught);
    } finally {
      setPasskeyBusy(null);
    }
  };

  const renamePasskey = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (renamingId === null) {
      return;
    }
    const name = renameValue.trim();
    if (name === '') {
      setFormError(t('account.passkey.nameRequired'));
      return;
    }
    setFormError(null);
    setPasskeyBusy(`rename:${renamingId}`);
    try {
      await api.renamePasskey({ factorId: renamingId, name });
      setRenamingId(null);
      setRenameValue('');
      setNotice(t('account.passkey.renamed'));
      setReload((value) => value + 1);
    } catch (caught) {
      report(caught);
    } finally {
      setPasskeyBusy(null);
    }
  };

  const totp = status?.totp ?? null;
  const totpConfirmed = totp?.confirmed === true;
  const passkeyList = status?.webauthn ?? [];
  const confirmed = totpConfirmed || passkeyList.length > 0;

  return (
    <Card data-testid="mfa-section">
      <CardHeader>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold leading-none">{t('account.mfa.title')}</h2>
          <Badge variant={confirmed ? 'default' : 'outline'} data-testid="mfa-badge">
            {confirmed ? t('account.mfa.badgeEnabled') : t('account.mfa.badgeDisabled')}
          </Badge>
        </div>
        <CardDescription>{t('account.mfa.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && status === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner label={t('common.loading')} />
            <span>{t('common.loading')}</span>
          </div>
        ) : null}

        {loadError !== null && status === null ? (
          <Alert variant="destructive" data-testid="mfa-load-error">
            <AlertTitle>{t('account.mfa.errorTitle')}</AlertTitle>
            <AlertDescription>{t(loadError)}</AlertDescription>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={() => setReload((value) => value + 1)}
            >
              {t('account.retry')}
            </Button>
          </Alert>
        ) : null}

        {notice === null ? null : (
          <Alert className="mb-4" data-testid="mfa-notice" aria-live="polite">
            <AlertTitle>{t('account.mfa.title')}</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {formError === null ? null : (
          <Alert
            variant="destructive"
            className="mb-4"
            data-testid="mfa-error"
            aria-live="assertive"
          >
            <AlertTitle>{t('account.mfa.errorTitle')}</AlertTitle>
            <AlertDescription>{t(formError)}</AlertDescription>
          </Alert>
        )}

        {recoveryCodes === null ? null : (
          <Alert className="mb-4" data-testid="mfa-recovery-codes" aria-live="polite">
            <AlertTitle>{t('account.mfa.recoveryTitle')}</AlertTitle>
            <AlertDescription>
              <p className="mb-2">{t('account.mfa.recoveryDescription')}</p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-sm" dir="ltr">
                {recoveryCodes.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                data-testid="mfa-recovery-done"
                onClick={() => setRecoveryCodes(null)}
              >
                {t('account.mfa.done')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {status !== null && !totpConfirmed && enrollment === null ? (
          <div className="grid gap-2">
            <Button
              type="button"
              data-testid="mfa-enable"
              disabled={busy !== null || status.available === false}
              onClick={() => void startEnrollment()}
            >
              {busy === 'enroll' ? t('account.mfa.enabling') : t('account.mfa.enable')}
            </Button>
            {status.available === false ? (
              <p className="text-xs text-muted-foreground">{t('account.mfa.errorUnavailable')}</p>
            ) : null}
          </div>
        ) : null}

        {enrollment === null ? null : (
          <div className="grid gap-4" data-testid="mfa-enrollment">
            <div>
              <h3 className="text-sm font-semibold">{t('account.mfa.secretTitle')}</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('account.mfa.secretDescription')}
              </p>
              <dl className="grid gap-1 text-sm">
                <dt className="text-muted-foreground">{t('account.mfa.secretLabel')}</dt>
                <dd className="font-mono break-all" dir="ltr" data-testid="mfa-secret">
                  {enrollment.secret}
                </dd>
                <dt className="text-muted-foreground">{t('account.mfa.otpauthLabel')}</dt>
                <dd className="font-mono break-all text-xs" dir="ltr">
                  {enrollment.otpauthUri}
                </dd>
              </dl>
            </div>

            <form
              className="grid gap-2"
              noValidate
              onSubmit={(event) => void confirmEnrollment(event)}
            >
              <Label htmlFor={CODE_ID}>{t('account.mfa.codeLabel')}</Label>
              <Input
                id={CODE_ID}
                name="code"
                type="text"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={codeError === null ? undefined : true}
                aria-describedby={codeError === null ? undefined : `${CODE_ID}-error`}
              />
              {codeError === null ? null : (
                <p id={`${CODE_ID}-error`} role="alert" className="text-xs text-destructive">
                  {codeError}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy !== null} data-testid="mfa-verify">
                  {busy === 'verify' ? t('account.mfa.verifying') : t('account.mfa.verify')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setEnrollment(null);
                    setCode('');
                    setCodeError(null);
                  }}
                >
                  {t('account.mfa.cancel')}
                </Button>
              </div>
            </form>
          </div>
        )}

        {totpConfirmed ? (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              {t('account.mfa.recoveryRemaining', {
                count: status?.recoveryCodesRemaining ?? 0,
              })}{' '}
              · {t('account.mfa.lastUsed')}:{' '}
              {totp?.lastUsedAt === null || totp?.lastUsedAt === undefined
                ? t('account.mfa.never')
                : dateFormatter.format(new Date(totp.lastUsedAt))}
            </p>

            <form className="grid gap-2" noValidate onSubmit={(event) => void regenerate(event)}>
              <Label htmlFor={REGENERATE_PASSWORD_ID}>{t('account.mfa.passwordLabel')}</Label>
              <Input
                id={REGENERATE_PASSWORD_ID}
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={busy !== null}
                data-testid="mfa-regenerate"
              >
                {busy === 'regenerate'
                  ? t('account.mfa.regenerating')
                  : t('account.mfa.regenerate')}
              </Button>
            </form>

            <form className="grid gap-2" noValidate onSubmit={(event) => void disable(event)}>
              <h3 className="text-sm font-semibold">{t('account.mfa.disableTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('account.mfa.disableDescription')}</p>
              <Label htmlFor={DISABLE_PASSWORD_ID}>{t('account.mfa.disablePassword')}</Label>
              <Input
                id={DISABLE_PASSWORD_ID}
                name="disablePassword"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
              />
              <Label htmlFor={DISABLE_CODE_ID}>{t('account.mfa.disableCodeLabel')}</Label>
              <Input
                id={DISABLE_CODE_ID}
                name="disableCode"
                type="text"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={disableCode}
                onChange={(event) => setDisableCode(event.target.value)}
              />
              <Button
                type="submit"
                variant="destructive"
                disabled={busy !== null}
                data-testid="mfa-disable"
              >
                {busy === 'disable' ? t('account.mfa.disabling') : t('account.mfa.disable')}
              </Button>
            </form>
          </div>
        ) : null}

        <section
          className="mt-6 grid gap-3 border-t border-border pt-4"
          aria-labelledby="account-passkeys-title"
          data-testid="passkey-section"
        >
          <div>
            <h3 id="account-passkeys-title" className="text-sm font-semibold">
              {t('account.passkey.title')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('account.passkey.description')}</p>
          </div>

          {passkeyList.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="passkey-empty">
              {t('account.passkey.empty')}
            </p>
          ) : (
            <ul className="grid gap-2" data-testid="passkey-list">
              {passkeyList.map((factor) => (
                <li
                  key={factor.id}
                  className="grid gap-2 rounded-md border border-border p-3"
                  data-testid={`passkey-${factor.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{factor.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('account.passkey.deviceType')}:{' '}
                      {factor.backedUp === true
                        ? t('account.passkey.backedUp')
                        : (factor.deviceType ?? t('account.passkey.singleDevice'))}
                    </span>
                  </div>
                  <dl className="grid gap-1 text-xs text-muted-foreground">
                    <div className="flex gap-2">
                      <dt>{t('account.passkey.createdAt')}:</dt>
                      <dd>{dateFormatter.format(new Date(factor.createdAt))}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt>{t('account.mfa.lastUsed')}:</dt>
                      <dd>
                        {factor.lastUsedAt === null
                          ? t('account.mfa.never')
                          : dateFormatter.format(new Date(factor.lastUsedAt))}
                      </dd>
                    </div>
                  </dl>

                  {renamingId === factor.id ? (
                    <form
                      className="flex flex-wrap items-end gap-2"
                      onSubmit={(event) => void renamePasskey(event)}
                    >
                      <div className="grid gap-1">
                        <Label htmlFor={`passkey-rename-${factor.id}`}>
                          {t('account.passkey.nameLabel')}
                        </Label>
                        <Input
                          id={`passkey-rename-${factor.id}`}
                          value={renameValue}
                          maxLength={64}
                          onChange={(event) => setRenameValue(event.target.value)}
                        />
                      </div>
                      <Button type="submit" size="sm" disabled={passkeyBusy !== null}>
                        {t('account.passkey.save')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={passkeyBusy !== null}
                        onClick={() => {
                          setRenamingId(null);
                          setRenameValue('');
                        }}
                      >
                        {t('account.mfa.cancel')}
                      </Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={passkeyBusy !== null}
                        aria-label={`${t('account.passkey.rename')} ${factor.name}`}
                        onClick={() => {
                          setRenamingId(factor.id);
                          setRenameValue(factor.name);
                          setFormError(null);
                        }}
                      >
                        {t('account.passkey.rename')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={passkeyBusy !== null}
                        aria-label={`${t('account.passkey.delete')} ${factor.name}`}
                        onClick={() => void removePasskey(factor)}
                      >
                        {passkeyBusy === `delete:${factor.id}`
                          ? t('account.passkey.deleting')
                          : t('account.passkey.delete')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form className="grid gap-2" onSubmit={(event) => void enrollPasskey(event)}>
            <Label htmlFor={PASSKEY_NAME_ID}>{t('account.passkey.nameLabel')}</Label>
            <Input
              id={PASSKEY_NAME_ID}
              name="passkeyName"
              value={passkeyName}
              maxLength={64}
              placeholder={t('account.passkey.namePlaceholder')}
              onChange={(event) => setPasskeyName(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={passkeyBusy !== null}
              data-testid="passkey-enroll"
            >
              {passkeyBusy === 'enroll'
                ? t('account.passkey.enrolling')
                : t('account.passkey.enroll')}
            </Button>
          </form>
        </section>
      </CardContent>
    </Card>
  );
}
