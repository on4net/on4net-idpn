import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { Locale } from '@/i18n';
import { useTranslate } from '@/i18n/translation-context';

/**
 * Consent screen of the Hosted UI (card #81, docs/auth-flows.md).
 *
 * `/oauth2/authorize` parks the validated request on the server and sends the browser here with
 * an opaque `consent_request` handle. This page shows what is being asked, the user answers, and
 * the server resumes or aborts the authorization from its own copy: the page never builds an
 * authorize URL, and the only navigation target it follows is the `redirectTo` the API returns.
 */

export interface ConsentDetails {
  client: { clientId: string; name: string };
  scopes: string[];
}

export type ConsentLoadResult =
  { ok: true; details: ConsentDetails } | { ok: false; error: 'login' | 'not_found' | 'network' };

export type ConsentDecisionResult =
  { ok: true; redirectTo: string | null } | { ok: false; error: 'login' | 'not_found' | 'network' };

export interface ConsentPageProps {
  locale: Locale;
  /** Opaque handle from the query string; without one there is nothing to decide. */
  consentRequest: string | undefined;
  load(consentRequest: string): Promise<ConsentLoadResult>;
  decide(consentRequest: string, decision: 'allow' | 'deny'): Promise<ConsentDecisionResult>;
  /** Called with the validated absolute target after a decision. */
  onRedirect(target: string): void;
}

/** Scopes with a human sentence; anything else is shown generically, never as raw markup. */
const KNOWN_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

const SCOPE_TOKEN = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * The API already validated this URL, but a page that navigates must not trust a string:
 * only absolute http(s) URLs qualify (no `javascript:`, `data:`, or relative surprises).
 */
export function safeConsentTarget(value: string | null): string | null {
  if (value === null || value === '') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const errorKey = (error: 'login' | 'not_found' | 'network'): string =>
  error === 'login'
    ? 'consent.errorLogin'
    : error === 'not_found'
      ? 'consent.errorNotFound'
      : 'consent.errorNetwork';

export function ConsentPage({
  locale,
  consentRequest,
  load,
  decide,
  onRedirect,
}: ConsentPageProps): React.ReactElement {
  const t = useTranslate(locale);
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const started = React.useRef(false);
  const [details, setDetails] = React.useState<ConsentDetails | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'deciding' | 'error'>(
    consentRequest === undefined || consentRequest === '' ? 'error' : 'loading',
  );
  const [error, setError] = React.useState<'login' | 'not_found' | 'network'>('not_found');

  React.useEffect(() => {
    if (consentRequest === undefined || consentRequest === '' || started.current) {
      return;
    }
    // StrictMode mounts twice in development; one read is enough and the first promise still
    // updates this component after the remount.
    started.current = true;
    void load(consentRequest)
      .then((result) => {
        if (result.ok) {
          setDetails(result.details);
          setState('ready');
        } else {
          setError(result.error);
          setState('error');
        }
      })
      .catch(() => {
        setError('network');
        setState('error');
      });
  }, [consentRequest, load]);

  // Keyboard and screen-reader users land on the question, not on an empty page.
  React.useEffect(() => {
    if (state === 'ready') {
      headingRef.current?.focus();
    }
  }, [state]);

  const answer = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (consentRequest === undefined || state === 'deciding') {
      return;
    }
    setState('deciding');
    try {
      const result = await decide(consentRequest, decision);
      if (!result.ok) {
        setError(result.error);
        setState('error');
        return;
      }
      const target = safeConsentTarget(result.redirectTo);
      if (target === null) {
        // The request was consumed but there is nowhere safe to send the browser.
        setError('not_found');
        setState('error');
        return;
      }
      onRedirect(target);
    } catch {
      setError('network');
      setState('error');
    }
  };

  const scopeLabel = (scope: string): string =>
    KNOWN_SCOPES.has(scope)
      ? t(`consent.scope.${scope}`)
      : t('consent.scope.other', { scope: SCOPE_TOKEN.test(scope) ? scope : '…' });

  const busy = state === 'deciding';

  return (
    <main
      className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-start shadow-sm"
      aria-busy={state === 'loading' || busy ? true : undefined}
    >
      {state === 'loading' ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label="" />
          <span role="status">{t('consent.loading')}</span>
        </div>
      ) : null}

      {state === 'error' ? (
        <Alert variant="destructive" data-testid="consent-error" aria-live="assertive">
          <AlertTitle>{t('consent.errorTitle')}</AlertTitle>
          <AlertDescription>{t(errorKey(error))}</AlertDescription>
        </Alert>
      ) : null}

      {(state === 'ready' || state === 'deciding') && details !== null ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-foreground outline-none"
            >
              {t('consent.appRequests', { app: details.client.name })}
            </h1>
            <p className="text-sm text-muted-foreground">{t('consent.description')}</p>
          </div>

          <section aria-labelledby="consent-scopes-title" className="grid gap-2">
            <h2 id="consent-scopes-title" className="text-sm font-medium text-foreground">
              {t('consent.scopes')}
            </h2>
            <ul className="grid gap-1 ps-5 text-sm text-foreground [list-style:disc]">
              {details.scopes.map((scope) => (
                <li key={scope}>{scopeLabel(scope)}</li>
              ))}
            </ul>
          </section>

          <p className="text-xs text-muted-foreground">{t('consent.revokeHint')}</p>

          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" disabled={busy} onClick={() => void answer('allow')}>
              {busy ? <Spinner label="" /> : null}
              <span>{t('consent.allow')}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void answer('deny')}
            >
              {t('consent.deny')}
            </Button>
          </div>
          <p role="status" className="sr-only">
            {busy ? t('consent.deciding') : ''}
          </p>
        </div>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// Default API bindings. Same-origin, cookie-authenticated; nothing secret is read or stored.
// ---------------------------------------------------------------------------------------------

async function callConsent(
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown } | 'network'> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    return 'network';
  }
  const body: unknown = await response.json().catch((): unknown => null);
  return { status: response.status, body };
}

const failure = (status: number): 'login' | 'not_found' | 'network' =>
  status === 401 ? 'login' : status >= 500 ? 'network' : 'not_found';

const isDetails = (value: unknown): value is ConsentDetails => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { client?: unknown; scopes?: unknown };
  const client = record.client as { clientId?: unknown; name?: unknown } | undefined;
  return (
    typeof client?.clientId === 'string' &&
    typeof client.name === 'string' &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === 'string')
  );
};

export async function defaultLoadConsent(consentRequest: string): Promise<ConsentLoadResult> {
  const result = await callConsent(
    `/api/v1/consent/requests/${encodeURIComponent(consentRequest)}`,
    { method: 'GET' },
  );
  if (result === 'network') {
    return { ok: false, error: 'network' };
  }
  if (result.status !== 200 || !isDetails(result.body)) {
    return { ok: false, error: failure(result.status) };
  }
  return { ok: true, details: result.body };
}

export async function defaultDecideConsent(
  consentRequest: string,
  decision: 'allow' | 'deny',
): Promise<ConsentDecisionResult> {
  const result = await callConsent(
    `/api/v1/consent/requests/${encodeURIComponent(consentRequest)}/decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
  if (result === 'network') {
    return { ok: false, error: 'network' };
  }
  const body = result.body as { redirectTo?: unknown } | null;
  if (result.status !== 200) {
    return { ok: false, error: failure(result.status) };
  }
  return {
    ok: true,
    redirectTo: typeof body?.redirectTo === 'string' ? body.redirectTo : null,
  };
}
