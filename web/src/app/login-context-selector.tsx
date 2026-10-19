import * as React from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Locale } from '@/i18n';
import { useTranslate } from '@/i18n/translation-context';

import {
  contextPolicyKeys,
  contextPresentation,
  type LoginContextSummary,
} from '@/app/login-context';

/**
 * Context selection screen of the Hosted Auth UI (`docs/login-contexts.md` 4.2).
 *
 * A native radio group inside a `fieldset`/`legend` is used instead of a listbox: every
 * option has a name and a description, the whole card is clickable, arrow keys move the
 * selection and the group exposes a single accessible name in both RTL and LTR. The
 * preselected option is the client's default context, so the form is never ambiguous.
 */
export interface LoginContextSelectorProps {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  contexts: readonly LoginContextSummary[];
  /** Currently effective context key; always one of `contexts`. */
  value: string;
  /** Context marked `is_default` on the server, shown with a badge. */
  defaultKey?: string;
  /** The requested context is unknown or disabled; it was replaced, not honoured. */
  invalidRequested?: boolean;
  onChange(next: string): void;
}

export function LoginContextSelector({
  locale,
  dir,
  contexts,
  value,
  defaultKey,
  invalidRequested = false,
  onChange,
}: LoginContextSelectorProps): React.ReactElement | null {
  const t = useTranslate(locale);
  const groupId = React.useId();
  const hintId = `${groupId}-hint`;

  if (contexts.length < 2) {
    return null;
  }

  return (
    <section
      dir={dir}
      aria-labelledby={`${groupId}-legend`}
      aria-describedby={hintId}
      className="mb-3 rounded-lg border border-border bg-card p-4 text-start shadow-sm"
      data-testid="login-context-selector"
    >
      <fieldset className="grid gap-2">
        <legend id={`${groupId}-legend`} className="mb-1 p-0 text-sm font-medium text-foreground">
          {t('login.context.selectorTitle')}
        </legend>
        <p id={hintId} className="mb-1 text-xs text-muted-foreground">
          {t('login.context.selectorHint')}
        </p>
        {invalidRequested ? (
          <Alert variant="destructive" className="mb-1">
            <AlertDescription>{t('login.context.unavailable')}</AlertDescription>
          </Alert>
        ) : null}
        {contexts.map((context) => {
          const checked = context.key === value;
          const optionId = `${groupId}-${context.key}`;
          const descriptionId = `${optionId}-description`;
          return (
            <label
              key={context.key}
              htmlFor={optionId}
              data-testid={`login-context-option-${context.key}`}
              data-selected={checked ? 'true' : undefined}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border p-3 text-start transition-colors',
                checked
                  ? 'border-primary bg-accent/40 ring-1 ring-ring'
                  : 'border-border hover:bg-accent/20',
              )}
            >
              <input
                id={optionId}
                type="radio"
                name={groupId}
                value={context.key}
                checked={checked}
                aria-describedby={context.description === undefined ? undefined : descriptionId}
                onChange={() => onChange(context.key)}
                className="mt-1 size-4 shrink-0 accent-[var(--idpn-primary)]"
              />
              <span className="grid gap-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {context.name}
                  {context.key === defaultKey ? (
                    <Badge variant="secondary">{t('login.context.defaultBadge')}</Badge>
                  ) : null}
                </span>
                {context.description === undefined ? null : (
                  <span id={descriptionId} className="text-xs text-muted-foreground">
                    {context.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}

export interface LoginContextPanelProps {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  context: LoginContextSummary;
}

/**
 * Branding and policy explanation of the selected context. The logo URL and the title come
 * from the validated public config; the theme is applied by `IdpnRoot` through tokens, so
 * no raw CSS exists here. Policy lines only explain what the server enforces.
 */
export function LoginContextPanel({
  locale,
  dir,
  context,
}: LoginContextPanelProps): React.ReactElement | null {
  const t = useTranslate(locale);
  const presentation = contextPresentation(context);
  const policyKeys = contextPolicyKeys(context);

  if (presentation === null && policyKeys.length === 0) {
    return null;
  }

  return (
    <section
      dir={dir}
      aria-label={t('login.context.panelLabel')}
      className="mb-3 grid gap-2 text-start"
      data-testid="login-context-panel"
      data-login-context={context.key}
    >
      {presentation === null ? null : (
        <div className="flex items-center gap-3">
          {presentation.logoUrl === undefined ? null : (
            // Decorative: the context title right next to it carries the name.
            <img
              src={presentation.logoUrl}
              alt=""
              aria-hidden="true"
              className="h-8 w-8 shrink-0 rounded-md object-contain"
            />
          )}
          <div className="grid gap-1">
            <p className="text-base font-semibold text-foreground">{presentation.title}</p>
            {presentation.description === undefined ? null : (
              <p className="text-xs text-muted-foreground">{presentation.description}</p>
            )}
          </div>
        </div>
      )}
      {policyKeys.length === 0 ? null : (
        <ul className="grid gap-1">
          {policyKeys.map((key) => (
            <li key={key} className="text-xs text-muted-foreground">
              {t(key)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Shown instead of the password form when the context allows other methods only. The
 * password form would advertise a method the context does not accept.
 */
export function LoginContextMethodNotice({
  locale,
  dir,
}: {
  locale: Locale;
  dir: 'rtl' | 'ltr';
}): React.ReactElement {
  const t = useTranslate(locale);
  return (
    <main
      dir={dir}
      className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-start shadow-sm"
      data-testid="login-context-method-notice"
    >
      <p className="text-base font-semibold text-foreground">{t('login.title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('login.context.passwordUnavailable')}</p>
    </main>
  );
}
