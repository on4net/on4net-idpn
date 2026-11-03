import {
  IDPN_MFE_EVENT_NAME,
  mountIdpnModule,
  type IdpnEvent,
  type IdpnMfeModule,
  type IdpnMountedModule,
} from '@idpn/mfe-sdk';

import { HostConfigError, parseHostConfig, type IdpnHostConfig } from '../host-mf/host-config';
import { redactEventDetail } from '../host-mf/host-events';
import { createInMemoryTokenProvider } from '../host-mf/token-provider';
import { DEFAULT_BUNDLE_URL, loadWebComponentBundle } from './bundle-loader';
import { toMfeConfig, type HostModuleSettings } from './mfe-config';

/**
 * Vanilla (non-React) host for the IDPN Web Component bundle.
 *
 * The host owns configuration and layout; the modules are mounted only through the
 * `@idpn/mfe-sdk` public API. Every style, Radix portal and theme token of the module
 * stays inside its Shadow Root, and events arrive both through the SDK handler and as
 * `idpn:event` `CustomEvent`s that bubble out of the module
 * (docs/micro-frontend.md 4.3 and 6).
 */

/** Container id per module. `mfe` is the historical id used by the isolation fixture. */
const MODULE_SLOTS: Readonly<Record<IdpnMfeModule, string>> = {
  'user-management': 'mfe',
  account: 'host-account',
};

interface HostElements {
  readonly fallback: HTMLElement | null;
  readonly fallbackMessage: HTMLElement | null;
  readonly fallbackLink: HTMLAnchorElement | null;
  readonly status: HTMLElement | null;
  readonly clientId: HTMLElement | null;
  readonly mode: HTMLElement | null;
  readonly locale: HTMLElement | null;
  readonly eventLog: HTMLElement | null;
  readonly eventCount: HTMLElement | null;
  readonly bubbledCount: HTMLElement | null;
  readonly mountButton: HTMLButtonElement | null;
  readonly unmountButton: HTMLButtonElement | null;
}

const element = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const readElements = (): HostElements => ({
  fallback: element('host-fallback'),
  fallbackMessage: element('host-fallback-message'),
  fallbackLink: element<HTMLAnchorElement>('host-fallback-link'),
  status: element('host-status-message'),
  clientId: element('host-client-id'),
  mode: element('host-mode'),
  locale: element('host-locale'),
  eventLog: element('host-events'),
  eventCount: element('host-event-count'),
  bubbledCount: element('host-bubbled-events'),
  mountButton: element<HTMLButtonElement>('host-mount'),
  unmountButton: element<HTMLButtonElement>('host-unmount'),
});

const setText = (target: HTMLElement | null, text: string): void => {
  if (target !== null) {
    target.textContent = text;
  }
};

/**
 * Shows the safe error surface: a `role="alert"` with a short, secret-free message and,
 * when the host configuration is valid, the documented Hosted UI fallback link.
 */
const showFallback = (elements: HostElements, message: string, loginUrl?: string): void => {
  setText(elements.fallbackMessage, message);
  if (elements.fallbackLink !== null && loginUrl !== undefined) {
    elements.fallbackLink.href = loginUrl;
    elements.fallbackLink.hidden = false;
  }
  if (elements.fallback !== null) {
    elements.fallback.hidden = false;
  }
};

const describeFailure = (error: unknown): string =>
  error instanceof Error && error.message !== ''
    ? error.message
    : 'The IDPN module could not be loaded.';

const renderConfig = (elements: HostElements, config: IdpnHostConfig): void => {
  setText(elements.clientId, config.clientId);
  setText(elements.mode, config.mode);
  setText(elements.locale, `${config.locale} (${config.dir})`);
};

export interface HostBootstrapOptions {
  /** Bundle URL override; used by the fallback fixture and by tests. */
  readonly bundleUrl?: string;
  /** Environment source; defaults to the host's build-time `VITE_IDPN_*` variables. */
  readonly env?: ImportMetaEnv;
}

/**
 * Boots the host: validates configuration, loads the versioned Web Component bundle and
 * mounts every configured module. Never throws for expected failures (invalid config,
 * missing bundle) - it renders the fallback instead.
 */
export async function bootstrapHost(options: HostBootstrapOptions = {}): Promise<void> {
  const elements = readElements();
  const env = options.env ?? import.meta.env;

  let config: IdpnHostConfig;
  try {
    config = parseHostConfig(env);
  } catch (error) {
    if (error instanceof HostConfigError) {
      const keys = error.issues.map((issue) => issue.key).join(', ');
      showFallback(elements, `The IDPN host is not configured: ${keys}.`);
    } else {
      showFallback(elements, 'The IDPN host configuration could not be read.');
    }
    return;
  }

  renderConfig(elements, config);

  // Created once. In the default `bff` mode the getter is never forwarded and the modules
  // use the HttpOnly session cookie; nothing is written to storage or cookies here.
  const tokens = createInMemoryTokenProvider();
  const mounted: IdpnMountedModule[] = [];
  let ready = false;
  let sdkEvents = 0;
  let domEvents = 0;

  const announce = (message: string): void => setText(elements.status, message);

  const appendEvent = (event: IdpnEvent): void => {
    if (elements.eventLog === null) {
      return;
    }
    const item = document.createElement('li');
    item.dataset.eventType = event.type;
    // Defense in depth: the contract is token-free; redaction keeps a future bug out of
    // the host DOM as well.
    item.textContent = JSON.stringify(redactEventDetail(event));
    elements.eventLog.append(item);
  };

  const settings: HostModuleSettings = {
    clientId: config.clientId,
    mode: config.mode,
    apiBaseUrl: config.apiBaseUrl,
    locale: config.locale,
    dir: config.dir,
    theme: config.theme,
    ...(config.mode === 'spa' ? { getAccessToken: tokens.getAccessToken } : {}),
    onEvent: (event) => {
      sdkEvents += 1;
      appendEvent(event);
      setText(elements.eventCount, String(sdkEvents));
    },
  };

  // The bundle publishes the same event as `bubbles: true, composed: true`. Listening on
  // the document proves the DOM contract for hosts that do not use the SDK handler.
  document.addEventListener(IDPN_MFE_EVENT_NAME, () => {
    domEvents += 1;
    setText(elements.bubbledCount, String(domEvents));
  });

  const unmountAll = (): void => {
    for (const handle of mounted.splice(0)) {
      handle.unmount();
    }
  };

  const mountAll = (): void => {
    unmountAll();
    for (const module of config.modules) {
      const container = document.getElementById(MODULE_SLOTS[module]);
      if (container === null) {
        continue;
      }
      mounted.push(mountIdpnModule(container, toMfeConfig(settings, module)));
    }
    announce(`Mounted ${mounted.length} module(s) for client ${config.clientId} (${config.mode}).`);
  };

  const fail = (error: unknown): void => {
    showFallback(elements, describeFailure(error), config.loginUrl);
    announce('The IDPN modules are unavailable; use the hosted page.');
  };

  elements.unmountButton?.addEventListener('click', () => {
    unmountAll();
    announce('Modules are unmounted.');
  });

  elements.mountButton?.addEventListener('click', () => {
    if (!ready) {
      fail(new Error('The IDPN Web Component bundle is not available.'));
      return;
    }
    try {
      mountAll();
    } catch (error) {
      fail(error);
    }
  });

  window.addEventListener('pagehide', () => {
    unmountAll();
    tokens.clear();
  });

  try {
    await loadWebComponentBundle(options.bundleUrl ?? env.VITE_IDPN_WC_URL ?? DEFAULT_BUNDLE_URL);
    ready = true;
    mountAll();
  } catch (error) {
    fail(error);
  }
}
