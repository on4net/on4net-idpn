import { IDPN_MFE_EVENT_NAME, type IdpnEvent } from '@idpn/mfe-sdk';
import { createRoot, type Root } from 'react-dom/client';

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
  private themeTokens?: Record<string, string>;

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

  /** Host theme tokens, forwarded to the MFE root as CSS custom properties. */
  get theme(): Record<string, string> | undefined {
    return this.themeTokens;
  }

  set theme(value: Record<string, string> | undefined) {
    this.themeTokens = value;
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

  private renderModule(): void {
    if (this.root === null) {
      return;
    }
    const clientId = this.getAttribute('client-id') ?? '';
    if (clientId === '') {
      this.root.render(
        <p dir="rtl" role="alert">
          client-id لازم است.
        </p>,
      );
      return;
    }

    const moduleName = this.module;
    if (moduleName === null) {
      this.root.render(
        <p dir="rtl" role="alert">
          module باید user-management یا account باشد.
        </p>,
      );
      return;
    }

    const locale = this.getAttribute('locale') ?? 'fa-IR';
    const dirAttribute = this.getAttribute('dir');
    const dir = dirAttribute === 'ltr' || dirAttribute === 'rtl' ? dirAttribute : undefined;
    const apiBaseUrl = this.getAttribute('api-base') ?? undefined;
    const theme = this.theme;
    const onEvent = this.deliverEvent;

    if (moduleName === 'account') {
      this.root.render(
        <AccountRoot
          clientId={clientId}
          locale={locale}
          {...(dir === undefined ? {} : { dir })}
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
        {...(dir === undefined ? {} : { dir })}
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
