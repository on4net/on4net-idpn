import * as React from 'react';

import { translate, type Locale } from '@/i18n';

/**
 * Neutral loading state for the Hosted shell. It is intentionally direction-agnostic
 * (symmetric blocks) so the frame between "document opened" and "client config resolved"
 * never shows a form in the wrong locale or direction. The resolved locale is announced
 * to assistive technology only after the real form paints.
 */
export function HostedLoginSkeleton({ locale }: { locale: Locale }): React.ReactElement {
  return (
    <main
      className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm"
      aria-busy="true"
      data-testid="hosted-login-skeleton"
    >
      <span className="sr-only" role="status">
        {translate(locale, 'common.loading')}
      </span>
      <div className="mb-6 grid gap-3" aria-hidden="true">
        <div className="h-6 w-32 rounded bg-muted" />
        <div className="h-4 w-full rounded bg-muted" />
      </div>
      <div className="grid gap-4" aria-hidden="true">
        <div className="grid gap-2">
          <div className="h-4 w-24 rounded bg-muted" />
          <div className="h-9 w-full rounded-md border border-input bg-muted" />
        </div>
        <div className="grid gap-2">
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="h-9 w-full rounded-md border border-input bg-muted" />
        </div>
        <div className="h-9 w-full rounded-md bg-muted" />
      </div>
    </main>
  );
}
