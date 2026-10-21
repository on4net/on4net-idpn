import {
  IDPN_MFE_EVENT_NAME,
  type IdpnEvent,
  type IdpnLocales,
  type IdpnTheme,
} from '@idpn/mfe-sdk';
import { createRoot, type Root } from 'react-dom/client';

import { isDirection, resolveDirection, resolveLocale, translate } from '@/i18n';
import { isSafeTarget } from '@/security/targets.ts';

import { AccountRoot, type AccountEvent } from './account';
import { UserManagementRoot, type UserManagementEvent } from './user-management';
import styles from '@/styles/globals.css?inline';

/** Modules embedded through the Web Component bundle (docs/micro-frontend.md 3). */
export type IdpnWebComponentModule = 'user-management' | 'account';

type IdpnWebComponentEvent = UserManagementEvent | AccountEvent;

export const USER_MANAGEMENT_ELEMENT_NAME = 'on4net-idpn-user-management';
export const ACCOUNT_ELEMENT_NAME = 'on4net-idpn-account';
export const MFE_ELEMENT_NAME = 'on4net-idpn-mfe';

/** Default module per tag; the generic tag requires the `module` attribute. */
const DEFAULT_MODULE_BY_TAG: Readonly<Record<string, IdpnWebComponentModule>> = {
  [USER_MANAGEMENT_ELEMENT_NAME]: 'user-management',
  [ACCOUNT_ELEMENT_NAME]: 'account',
};

const isModuleName = (value: string | null): value is IdpnWebComponentModule =>
  value === 'user-management' || value === 'account';

/**
 * Non-React host entry point for both embedded modules. Everything (styles, tokens,
 * portals) lives inside a Shadow Root, so a Vue/Angular/legacy host cannot leak CSS into
 * the module or receive MFE styles on its own elements.
 *
 * - `<on4net-idpn-user-management>` — legacy tag, still defaults to `user-management`.
 * - `<on4net-idpn-account>` — defaults to `account`.
 * - `<on4net-idpn-mfe module="…">` — explicit module selection.
 *
 * The `module` attribute/property overrides the tag default. `client-id` is configuration
 * owned by the host; the access token (SPA mode only) is provided through an in-memory
 * getter, never through an attribute.
 */
export class IdpnMfeElement extends HTMLElement {
  static observedAttributes = ['client-id', 'locale', 'dir', 'api-base', 'page-size', 'module'];

  private accessTokenGetter?: () => string | null;
  private eventHandler?: (event: IdpnWebComponentEvent) => void;
  private themeTokens?: IdpnTheme;
  private localesConfig?: IdpnLocales;

  /** SPA mode only: must return a token held in memory (never persisted). */
  get getAccessToken(): (() => string | null) | undefined {
    return this.accessTokenGetter;
  }

  set getAccessToken(value: (() => string | null) | undefined) {
    this.accessTokenGetter = value;
    this.renderModule();
  }

  /** Non-sensitive module events; never contains a token. */
  get onEvent(): ((event: IdpnWebComponentEvent) => void) | undefined {
    return this.eventHandler;
  }

  set onEvent(value: ((event: IdpnWebComponentEvent) => void) | undefined) {
    this.eventHandler = value;
    this.renderModule();
  }

  /**
   * Stable event delivery used by the modules (docs/micro-frontend.md 6):
   *
   * 1. publishes `CustomEvent<IdpnEvent>` named {@link IDPN_MFE_EVENT_NAME} with
   *    `bubbles: true` and `composed: true`, so a Vue/Angular/legacy host can listen on the
   *    element or on `document` without importing the SDK;
   * 2. forwards the same event to the in-memory `onEvent` property, if the host set one.
   *
   * The reference never changes, so React never re-fetches just because the element
   * re-rendered. The detail is the public event contract and never contains a token.
   */
  private readonly deliverEvent = (event: IdpnWebComponentEvent): void => {
    this.dispatchEvent(
      new CustomEvent<IdpnEvent>(IDPN_MFE_EVENT_NAME, {
        detail: event,
        bubbles: true,
        composed: true,
      }),
    );
    this.eventHandler?.(event);
  };

  /** Host theme tokens, forwarded to the MFE root and sanitized before reaching the DOM. */
  get theme(): IdpnTheme | undefined {
    return this.themeTokens;
  }

  set theme(value: IdpnTheme | undefined) {
    this.themeTokens = value;
    this.renderModule();
  }

  /**
   * Locales enabled by the client. Kept as an in-memory property (like `theme`) so only
   * validated values reach the module; the SDK forwards it from `IdpnMfeConfig.locales`.
   */
  get locales(): IdpnLocales | undefined {
    return this.localesConfig;
  }

  set locales(value: IdpnLocales | undefined) {
    this.localesConfig = value;
    this.renderModule();
  }

  private moduleOverride: IdpnWebComponentModule | null = null;
  private root: Root | null = null;
  private mountPoint: HTMLDivElement | null = null;

  /** Selected module; attribute/property override first, then the tag default. */
  get module(): IdpnWebComponentModule | null {
    if (this.moduleOverride !== null) {
      return this.moduleOverride;
    }
    const attribute = this.getAttribute('module');
    if (isModuleName(attribute)) {
      return attribute;
    }
    return DEFAULT_MODULE_BY_TAG[this.tagName.toLowerCase()] ?? null;
  }

  set module(value: IdpnWebComponentModule | null) {
    this.moduleOverride = isModuleName(value) ? value : null;
    this.renderModule();
  }

  connectedCallback(): void {
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    if (this.mountPoint === null) {
      const styleElement = document.createElement('style');
      styleElement.textContent = styles;
      shadow.appendChild(styleElement);
      this.mountPoint = document.createElement('div');
      shadow.appendChild(this.mountPoint);
    }
    // Re-mounting the same element after removal must create a fresh root; the old one
    // was unmounted and cannot be reused.
    this.root ??= createRoot(this.mountPoint);
    this.renderModule();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
  }

  attributeChangedCallback(): void {
    this.renderModule();
  }

  /**
   * `api-base` is host configuration but it is still an attribute, so it is validated like the
   * host's own targets: an absolute `http(s)` URL or a same-origin path with a single leading
   * slash. `\\`, `/\\` and `//` are protocol-relative tricks and fall back to same-origin
   * instead of sending the session cookie elsewhere.
   */
  private resolveApiBase(): string | undefined {
    const value = this.getAttribute('api-base');
    if (value === null || value.trim() === '') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!isSafeTarget(trimmed)) {
      console.warn('[idpn-mfe] ignoring an unsafe api-base attribute');
      return undefined;
    }
    return trimmed;
  }

  private renderModule(): void {
    if (this.root === null) {
      return;
    }
    const locale = resolveLocale({
      configLocale: this.getAttribute('locale'),
      supported: this.localesConfig?.supported,
      clientDefault: this.localesConfig?.default,
    });
    const dirAttribute = this.getAttribute('dir');
    const configDir = this.localesConfig?.dir?.[locale];
    const dir = resolveDirection(locale, isDirection(dirAttribute) ? dirAttribute : configDir);
    // The element is the host boundary; `lang` is mirrored so assistive technology sees
    // the resolved language even before entering the shadow root. Direction lives on
    // `.idpn-root` (and is only overwritten on the element when the host sets it).
    if (this.getAttribute('lang') !== locale) {
      this.setAttribute('lang', locale);
    }

    const clientId = this.getAttribute('client-id') ?? '';
    if (clientId === '') {
      this.root.render(
        <p dir={dir} lang={locale} role="alert">
          {translate(locale, 'errors.clientIdRequired')}
        </p>,
      );
      return;
    }

    const moduleName = this.module;
    if (moduleName === null) {
      this.root.render(
        <p dir={dir} lang={locale} role="alert">
          {translate(locale, 'errors.moduleInvalid')}
        </p>,
      );
      return;
    }

    const apiBaseUrl = this.resolveApiBase();
    const theme = this.theme;
    const locales = this.localesConfig;
    const onEvent = this.deliverEvent;

    if (moduleName === 'account') {
      this.root.render(
        <AccountRoot
          clientId={clientId}
          locale={locale}
          dir={dir}
          {...(locales === undefined ? {} : { locales })}
          {...(apiBaseUrl === undefined ? {} : { apiBaseUrl })}
          {...(theme === undefined ? {} : { theme })}
          onEvent={onEvent}
        />,
      );
      return;
    }

    const parsedPageSize = Number(this.getAttribute('page-size'));
    const pageSize =
      Number.isInteger(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : undefined;

    this.root.render(
      <UserManagementRoot
        clientId={clientId}
        locale={locale}
        dir={dir}
        {...(locales === undefined ? {} : { locales })}
        {...(apiBaseUrl === undefined ? {} : { apiBaseUrl })}
        {...(pageSize === undefined ? {} : { pageSize })}
        {...(theme === undefined ? {} : { theme })}
        {...(this.getAccessToken === undefined ? {} : { getAccessToken: this.getAccessToken })}
        onEvent={onEvent}
      />,
    );
  }
}

/** Backwards-compatible element for `<on4net-idpn-user-management>`. */
export class IdpnUserManagementElement extends IdpnMfeElement {}

/** Element for the embedded account module. */
export class IdpnAccountElement extends IdpnMfeElement {}

const register = (name: string, element: CustomElementConstructor): void => {
  if (typeof customElements !== 'undefined' && customElements.get(name) === undefined) {
    customElements.define(name, element);
  }
};

register(USER_MANAGEMENT_ELEMENT_NAME, IdpnUserManagementElement);
register(ACCOUNT_ELEMENT_NAME, IdpnAccountElement);
register(MFE_ELEMENT_NAME, IdpnMfeElement);
