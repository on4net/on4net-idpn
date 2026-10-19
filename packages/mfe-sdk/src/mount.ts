import type {
  IdpnEventHandler,
  IdpnMfeConfig,
  IdpnMfeModule,
  IdpnThemeTokens,
} from './contract.js';
import { assertIdpnMfeConfig } from './validate.js';

/** Custom element tag of every module, as registered by the Web Component bundle. */
export const IDPN_MFE_TAGS = {
  'user-management': 'on4net-idpn-user-management',
  account: 'on4net-idpn-account',
} as const satisfies Record<IdpnMfeModule, string>;

/**
 * Marker attribute the helper puts on elements it created. It is not sensitive and lets a
 * second `mountIdpnModule` call update the existing module instead of duplicating it.
 */
export const IDPN_MFE_MARKER_ATTRIBUTE = 'data-idpn-mfe';

/**
 * Minimal structural view of the Web Component element. The SDK does not depend on
 * `@idpn/web`; it only requires this shape, which both modules implement.
 */
export interface IdpnMfeElement extends HTMLElement {
  /** SPA mode only; in-memory token getter. Never written to an attribute. */
  getAccessToken?: () => string | null;
  /** Non-sensitive module events. Never carries a token. */
  onEvent?: IdpnEventHandler;
  /** CSS custom properties forwarded to the MFE root. */
  theme?: IdpnThemeTokens;
}

/** Handle returned by {@link mountIdpnModule}. */
export interface IdpnMountedModule {
  readonly element: IdpnMfeElement;
  /** Applies a new configuration; switches the custom element when `module` changes. */
  update(config: IdpnMfeConfig): void;
  /** Clears handlers/token getters and removes the custom element from the DOM. */
  unmount(): void;
}

const clearHandlers = (element: IdpnMfeElement): void => {
  element.getAccessToken = undefined;
  element.onEvent = undefined;
  element.theme = undefined;
};

const createElement = (module: IdpnMfeModule): IdpnMfeElement => {
  const element = document.createElement(IDPN_MFE_TAGS[module]) as IdpnMfeElement;
  element.setAttribute(IDPN_MFE_MARKER_ATTRIBUTE, '');
  return element;
};

const findMounted = (container: Element, module: IdpnMfeModule): IdpnMfeElement | null => {
  const tag = IDPN_MFE_TAGS[module];
  for (const child of Array.from(container.children)) {
    if (child.tagName.toLowerCase() === tag && child.hasAttribute(IDPN_MFE_MARKER_ATTRIBUTE)) {
      return child as IdpnMfeElement;
    }
  }
  return null;
};

const removeMounted = (container: Element): void => {
  for (const child of Array.from(container.children)) {
    if (child.hasAttribute(IDPN_MFE_MARKER_ATTRIBUTE)) {
      clearHandlers(child as IdpnMfeElement);
      child.remove();
    }
  }
};

const setOptionalAttribute = (element: Element, name: string, value: string | undefined): void => {
  if (value === undefined) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
};

/**
 * Writes configuration to the element. Attributes carry only non-sensitive identifiers;
 * the token getter and the event handler stay in memory as JavaScript properties.
 */
const applyConfig = (element: IdpnMfeElement, config: IdpnMfeConfig): void => {
  element.setAttribute('client-id', config.clientId);
  element.setAttribute('api-base', config.apiBaseUrl);
  setOptionalAttribute(element, 'locale', config.locale);
  setOptionalAttribute(element, 'dir', config.dir);

  element.theme = config.theme === undefined ? undefined : { ...config.theme };
  element.onEvent = config.onEvent;
  element.getAccessToken = config.mode === 'spa' ? config.getAccessToken : undefined;
};

/**
 * Mounts an IDPN module inside `container` and returns a handle.
 *
 * Calling it again for the same container and module updates the existing element (safe
 * for React StrictMode, HMR and route re-entry). Calling it for a different module
 * replaces the previous module. The helper never touches `window`, storage or global
 * state, and never writes a token into the DOM.
 *
 * @throws TypeError when the config is invalid or contains a token/secret field.
 * @throws Error when called without a DOM (SSR).
 */
export function mountIdpnModule(container: Element, config: IdpnMfeConfig): IdpnMountedModule {
  if (typeof document === 'undefined' || typeof Element === 'undefined') {
    throw new Error('mountIdpnModule requires a DOM environment; mount it on the client.');
  }
  if (
    container === null ||
    typeof container !== 'object' ||
    typeof container.appendChild !== 'function'
  ) {
    throw new TypeError('mountIdpnModule requires a DOM element as the mount container.');
  }
  assertIdpnMfeConfig(config);

  const found = findMounted(container, config.module);
  const isNew = found === null;
  if (isNew) {
    removeMounted(container);
  }
  let element: IdpnMfeElement = found ?? createElement(config.module);
  // Configure before connecting so the module renders once with attributes, theme and
  // handlers already in place.
  applyConfig(element, config);
  if (isNew) {
    container.appendChild(element);
  }
  let active = config;

  return {
    get element() {
      return element;
    },
    update(next: IdpnMfeConfig): void {
      assertIdpnMfeConfig(next);
      if (next.module !== active.module) {
        const replacement = findMounted(container, next.module) ?? createElement(next.module);
        if (replacement !== element) {
          clearHandlers(element);
          element.remove();
          container.appendChild(replacement);
          element = replacement;
        }
      }
      applyConfig(element, next);
      active = next;
    },
    unmount(): void {
      clearHandlers(element);
      element.remove();
    },
  };
}

/** Convenience wrapper for hosts that keep only the handle. */
export function unmountIdpnModule(mounted: IdpnMountedModule): void {
  mounted.unmount();
}
