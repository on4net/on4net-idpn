import { createRoot, type Root } from 'react-dom/client';

import { IdpnRoot } from '@/app/idpn-root';
import styles from '@/styles/globals.css?inline';
import { UserManagement } from './user-management';

const ELEMENT_NAME = 'on4net-idpn-user-management';

/**
 * Non-React host entry point. Everything (styles, tokens, portals) lives inside a
 * Shadow Root, so a Vue/Angular/legacy host cannot leak CSS into the module or
 * receive MFE styles on its own elements.
 */
export class IdpnUserManagementElement extends HTMLElement {
  static observedAttributes = ['locale', 'dir'];

  private root: Root | null = null;
  private mountPoint: HTMLDivElement | null = null;

  connectedCallback(): void {
    if (this.shadowRoot !== null) {
      return;
    }
    const shadow = this.attachShadow({ mode: 'open' });
    const styleElement = document.createElement('style');
    styleElement.textContent = styles;
    shadow.appendChild(styleElement);

    this.mountPoint = document.createElement('div');
    shadow.appendChild(this.mountPoint);
    this.root = createRoot(this.mountPoint);
    this.renderModule();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
    this.mountPoint = null;
  }

  attributeChangedCallback(): void {
    this.renderModule();
  }

  private renderModule(): void {
    if (this.root === null) {
      return;
    }
    const locale = this.getAttribute('locale') ?? 'fa-IR';
    const dir = this.getAttribute('dir') === 'ltr' ? 'ltr' : 'rtl';
    this.root.render(
      <IdpnRoot locale={locale} dir={dir}>
        <UserManagement />
      </IdpnRoot>,
    );
  }
}

if (typeof customElements !== 'undefined' && customElements.get(ELEMENT_NAME) === undefined) {
  customElements.define(ELEMENT_NAME, IdpnUserManagementElement);
}
