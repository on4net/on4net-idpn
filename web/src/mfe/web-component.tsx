import { createRoot, type Root } from 'react-dom/client';

import { UserManagementRoot, type UserManagementEvent } from './user-management';
import styles from '@/styles/globals.css?inline';

const ELEMENT_NAME = 'on4net-idpn-user-management';

/**
 * Non-React host entry point. Everything (styles, tokens, portals) lives inside a
 * Shadow Root, so a Vue/Angular/legacy host cannot leak CSS into the module or
 * receive MFE styles on its own elements.
 *
 * `client-id` is configuration owned by the host; the access token (SPA mode only) is
 * provided through an in-memory getter, never through an attribute.
 */
export class IdpnUserManagementElement extends HTMLElement {
  static observedAttributes = ['client-id', 'locale', 'dir', 'api-base', 'page-size'];

  /** SPA mode only: must return a token held in memory (never persisted). */
  getAccessToken?: () => string | null;

  /** Non-sensitive module events; never contains a token. */
  onEvent?: (event: UserManagementEvent) => void;

  private root: Root | null = null;
  private mountPoint: HTMLDivElement | null = null;

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

    const locale = this.getAttribute('locale') ?? 'fa-IR';
    const dir = this.getAttribute('dir') === 'ltr' ? 'ltr' : 'rtl';
    const apiBaseUrl = this.getAttribute('api-base') ?? undefined;
    const parsedPageSize = Number(this.getAttribute('page-size'));
    const pageSize =
      Number.isInteger(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : undefined;

    this.root.render(
      <UserManagementRoot
        clientId={clientId}
        locale={locale}
        dir={dir}
        {...(apiBaseUrl === undefined ? {} : { apiBaseUrl })}
        {...(pageSize === undefined ? {} : { pageSize })}
        {...(this.getAccessToken === undefined ? {} : { getAccessToken: this.getAccessToken })}
        {...(this.onEvent === undefined ? {} : { onEvent: this.onEvent })}
      />,
    );
  }
}

if (typeof customElements !== 'undefined' && customElements.get(ELEMENT_NAME) === undefined) {
  customElements.define(ELEMENT_NAME, IdpnUserManagementElement);
}
