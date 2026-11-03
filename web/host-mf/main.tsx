import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/globals.css';
import './host-mf.css';

import { HostApp } from './HostApp';
import { HostConfigError, parseHostConfig, type HostConfigIssue } from './host-config';
import { createHostEventLogger } from './host-events';
import { remoteLoaders } from './remote-loaders';
import { createInMemoryTokenProvider } from './token-provider';

/** Rendered instead of the modules when the build-time host config is incomplete. */
function ConfigErrorView({ issues }: { issues: readonly HostConfigIssue[] }) {
  return (
    <div className="idpn-host-alert" role="alert" data-testid="idpn-host-config-error">
      <p className="idpn-host-alert__title">The Module Federation host is not configured.</p>
      <ul>
        {issues.map((issue) => (
          <li key={issue.key}>
            <code>{issue.key}</code>: {issue.message}
          </li>
        ))}
      </ul>
      <p>See the &quot;React host (Module Federation)&quot; section of docs/mfe-sdk.md.</p>
    </div>
  );
}

const container = document.getElementById('host-root');
if (container === null) {
  throw new Error('Missing #host-root element');
}

const root = createRoot(container);

function bootstrap(): void {
  let config;
  try {
    config = parseHostConfig(import.meta.env);
  } catch (error) {
    if (error instanceof HostConfigError) {
      root.render(
        <StrictMode>
          <ConfigErrorView issues={error.issues} />
        </StrictMode>,
      );
      return;
    }
    throw error;
  }

  // BFF is the default: the token provider exists but its getter is only forwarded in
  // `spa` mode. A host with a local OIDC client calls `setAccessToken` after a silent
  // renew; this demo has none, so the getter stays empty and the module renders its own
  // unauthorized state without a token ever reaching the browser bundle.
  const tokens = createInMemoryTokenProvider();
  const onEvent = createHostEventLogger((message, details) => {
    console.info(message, details);
  });

  root.render(
    <StrictMode>
      <HostApp
        config={config}
        loaders={remoteLoaders}
        onEvent={onEvent}
        {...(config.mode === 'spa' ? { getAccessToken: tokens.getAccessToken } : {})}
      />
    </StrictMode>,
  );

  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}

bootstrap();
