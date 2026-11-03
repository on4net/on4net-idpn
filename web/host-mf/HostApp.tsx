import * as React from 'react';
import type { IdpnEventHandler, IdpnEvent, IdpnMfeModule } from '@idpn/mfe-sdk';

import { MODULE_LABEL, toModuleProps, type IdpnHostConfig } from './host-config';
import { IdpnModuleHost, type RemoteLoader } from './IdpnModuleHost';

export interface HostAppProps {
  config: IdpnHostConfig;
  /** Injected so tests exercise loading/error states without Module Federation. */
  loaders: Record<IdpnMfeModule, RemoteLoader>;
  /** Logs redacted events (see `createHostEventLogger`). */
  onEvent?: IdpnEventHandler;
  /** SPA mode only; the host auth client owns the in-memory token. */
  getAccessToken?: () => string | null;
}

/**
 * The application shell around the federated modules.
 *
 * It renders the host's own configuration (never user input), one isolated slot per
 * configured module, and an accessible banner when a remote reports `auth:error`.
 */
export function HostApp({ config, loaders, onEvent, getAccessToken }: HostAppProps) {
  const [lastError, setLastError] = React.useState<string | null>(null);

  const handleEvent = React.useCallback(
    (event: IdpnEvent) => {
      onEvent?.(event);
      if (event.type === 'auth:error') {
        setLastError(event.code);
      }
    },
    [onEvent],
  );

  const moduleProps = React.useMemo(
    () =>
      toModuleProps(config, {
        onEvent: handleEvent,
        ...(getAccessToken === undefined ? {} : { getAccessToken }),
      }),
    [config, handleEvent, getAccessToken],
  );

  return (
    <div className="idpn-host-app" dir="ltr" lang="en">
      {lastError === null ? null : (
        <div className="idpn-host-alert" role="alert" data-testid="idpn-host-error">
          <p className="idpn-host-alert__title">The identity service reported an error.</p>
          <p className="idpn-host-alert__code">
            Code: <code data-testid="idpn-host-error-code">{lastError}</code>
          </p>
          <button
            type="button"
            className="idpn-host-alert__dismiss"
            onClick={() => setLastError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <dl className="idpn-host-config" data-testid="idpn-host-config">
        <dt>Client</dt>
        <dd data-testid="idpn-host-client-id">{config.clientId}</dd>
        <dt>Mode</dt>
        <dd data-testid="idpn-host-mode">{config.mode}</dd>
        <dt>Login context</dt>
        <dd data-testid="idpn-host-login-context">{config.loginContext}</dd>
        <dt>Locale</dt>
        <dd data-testid="idpn-host-locale">
          {config.locale} ({config.dir})
        </dd>
      </dl>

      {config.modules.map((module) => (
        <section
          key={module}
          className="idpn-host-section"
          aria-labelledby={`idpn-host-${module}-heading`}
          data-testid={`idpn-host-slot-${module}`}
        >
          <h2 id={`idpn-host-${module}-heading`} className="idpn-host-section__title">
            {MODULE_LABEL[module]}
          </h2>
          <IdpnModuleHost
            module={module}
            load={loaders[module]}
            moduleProps={moduleProps}
            loginUrl={config.loginUrl}
          />
        </section>
      ))}
    </div>
  );
}
