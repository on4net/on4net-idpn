import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDPN_MFE_EVENT_NAME } from '@idpn/mfe-sdk';

import {
  ACCOUNT_ELEMENT_NAME,
  IdpnAccountElement,
  IdpnMfeElement,
  IdpnUserManagementElement,
  MFE_ELEMENT_NAME,
  USER_MANAGEMENT_ELEMENT_NAME,
} from './web-component';

const ELEMENT = USER_MANAGEMENT_ELEMENT_NAME;
/** Stand-in for an in-memory SPA token; assertions make sure it never leaves memory. */
const TOKEN = 'in-memory-access-token-1';

const membersBody = {
  items: [
    {
      membershipId: 'm1',
      userId: 'u1',
      email: 'sara@example.com',
      username: 'sara',
      displayName: 'سارا محمدی',
      userStatus: 'active',
      status: 'active',
      attributes: {},
      roleKeys: ['app-a:member'],
      invitedAt: null,
      joinedAt: '2026-10-19T09:00:00.000Z',
      createdAt: '2026-10-19T09:00:00.000Z',
      updatedAt: '2026-10-19T09:00:00.000Z',
    },
  ],
  page: 1,
  limit: 10,
  total: 1,
};

const rolesBody = { items: [{ id: 'r1', key: 'app-a:member', name: 'عضو' }] };

const profileBody = {
  id: 'u1',
  username: 'sara',
  email: 'sara@example.com',
  displayName: 'سارا محمدی',
  phone: null,
  avatarUrl: null,
  locale: 'fa-IR',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  createdAt: '2026-10-19T09:00:00.000Z',
  passwordChangedAt: null,
};

const sessionsBody = { items: [], page: 1, limit: 20, total: 0 };

const mfaBody = {
  factors: [],
  totp: null,
  recoveryCodesRemaining: 0,
  available: true,
  webauthn: [],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const bodyFor = (url: string): unknown => {
  if (url.includes('/api/v1/account/profile')) return profileBody;
  if (url.includes('/api/v1/account/sessions')) return sessionsBody;
  if (url.includes('/api/v1/account/mfa')) return mfaBody;
  if (url.includes('/api/v1/roles')) return rolesBody;
  return membersBody;
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return Promise.resolve(jsonResponse(bodyFor(url)));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const mount = (attributes: Record<string, string> = {}, tag: string = ELEMENT) => {
  const element = document.createElement(tag) as IdpnMfeElement;
  element.setAttribute('client-id', 'app-a');
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  return element;
};

const requestedUrls = (): string[] => fetchMock.mock.calls.map(([input]) => String(input));

describe('IdpnUserManagementElement', () => {
  it('registers the custom element', () => {
    expect(customElements.get(ELEMENT)).toBe(IdpnUserManagementElement);
  });

  it('mounts the module inside a shadow root with scoped styles', async () => {
    const element = mount();
    const shadow = element.shadowRoot;
    expect(shadow).not.toBeNull();
    expect(shadow?.querySelector('style')).not.toBeNull();

    await waitFor(() => expect(shadow?.textContent).toContain('سارا محمدی'));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/clients/app-a/members');
  });

  it('uses locale, dir and page-size attributes', async () => {
    const element = mount({ locale: 'en-US', dir: 'ltr', 'page-size': '5' });
    const shadow = element.shadowRoot;

    await waitFor(() => expect(shadow?.textContent).toContain('سارا محمدی'));
    const root = shadow?.querySelector('.idpn-root');
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root).toHaveAttribute('lang', 'en-US');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=5');
  });

  it('resolves the locale against the host locales config and sets lang/dir on the element', async () => {
    const element = mount({ locale: 'de-DE' });
    element.locales = {
      default: 'en-US',
      supported: ['en-US'],
      dir: { 'en-US': 'ltr' },
    };

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('Member management'));
    expect(element).toHaveAttribute('lang', 'en-US');
    const root = element.shadowRoot?.querySelector('.idpn-root');
    expect(root).toHaveAttribute('lang', 'en-US');
    expect(root).toHaveAttribute('dir', 'ltr');
  });

  it('honours the validated per-locale direction override from the host config', async () => {
    const element = mount({ locale: 'fa-IR' });
    element.locales = {
      default: 'fa-IR',
      supported: ['fa-IR'],
      dir: { 'fa-IR': 'ltr' },
    };

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(element.shadowRoot?.querySelector('.idpn-root')).toHaveAttribute('dir', 'ltr');
  });

  it('passes an in-memory token getter to the API client', async () => {
    const element = document.createElement(ELEMENT) as IdpnUserManagementElement;
    element.setAttribute('client-id', 'app-a');
    element.getAccessToken = () => 'token-1';
    document.body.appendChild(element);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      ['Bearer', 'token-1'].join(' '),
    );
  });

  it('shows a requirement message without client-id and recovers when it is set', async () => {
    const element = document.createElement(ELEMENT) as IdpnUserManagementElement;
    document.body.appendChild(element);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('client-id لازم است.'));
    expect(fetchMock).not.toHaveBeenCalled();

    element.setAttribute('client-id', 'app-a');
    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
  });

  it('re-mounts after removal without duplicating the mount point', async () => {
    const element = mount();
    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));

    element.remove();
    document.body.appendChild(element);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(element.shadowRoot?.querySelectorAll('.idpn-root')).toHaveLength(1);
    expect(element.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
  });

  it('renders the API error state inside the shadow root', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ title: 'Forbidden' }, 403)));
    const element = mount();

    await waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain('دسترسی به مدیریت اعضای این اپ مجاز نیست.'),
    );
  });
});

describe('Web Component module selection', () => {
  it('registers both modules and the generic element', () => {
    expect(customElements.get(ELEMENT)).toBe(IdpnUserManagementElement);
    expect(customElements.get(ACCOUNT_ELEMENT_NAME)).toBe(IdpnAccountElement);
    expect(customElements.get(MFE_ELEMENT_NAME)).toBe(IdpnMfeElement);
  });

  it('mounts the account module through its own tag', async () => {
    const element = mount({}, ACCOUNT_ELEMENT_NAME);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(requestedUrls().some((url) => url.includes('/api/v1/account/profile'))).toBe(true);
    expect(element.shadowRoot?.querySelector('[data-testid="account-module"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('.idpn-root')).toHaveAttribute('dir', 'rtl');
  });

  it('keeps the legacy tag working without a module attribute', async () => {
    const element = mount();

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(requestedUrls().some((url) => url.includes('/api/v1/clients/app-a/members'))).toBe(true);
    expect(element.module).toBe('user-management');
  });

  it('selects the account module with the module attribute on the legacy tag', async () => {
    const element = mount({ module: 'account' });

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(element.module).toBe('account');
    expect(requestedUrls().some((url) => url.includes('/api/v1/account/profile'))).toBe(true);
    expect(element.shadowRoot?.querySelector('[data-testid="account-module"]')).not.toBeNull();
  });

  it('mounts the module selected by the generic tag', async () => {
    const element = mount({ module: 'user-management' }, MFE_ELEMENT_NAME);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(element.module).toBe('user-management');
    expect(requestedUrls().some((url) => url.includes('/api/v1/clients/app-a/members'))).toBe(true);
  });

  it('requires module on the generic tag', async () => {
    const element = mount({}, MFE_ELEMENT_NAME);

    await waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain(
        'module باید user-management یا account باشد.',
      ),
    );
    expect(element.module).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switches module through the in-memory property', async () => {
    const element = mount({}, ACCOUNT_ELEMENT_NAME);
    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));

    element.module = 'user-management';

    await waitFor(() =>
      expect(requestedUrls().some((url) => url.includes('/api/v1/clients/app-a/members'))).toBe(
        true,
      ),
    );
    expect(element.shadowRoot?.querySelector('[data-testid="account-module"]')).toBeNull();
    expect(element.shadowRoot?.querySelectorAll('.idpn-root')).toHaveLength(1);
  });

  it('forwards theme tokens to the shared root', async () => {
    const element = document.createElement(ACCOUNT_ELEMENT_NAME) as IdpnAccountElement;
    element.setAttribute('client-id', 'app-a');
    element.theme = { primary: '#123456', radius: '8px' };
    document.body.appendChild(element);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    const root = element.shadowRoot?.querySelector('.idpn-root') as HTMLElement;
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('#123456');
    expect(root.style.getPropertyValue('--idpn-radius')).toBe('8px');
    expect(root.style.getPropertyValue('--primary')).toBe('');
  });

  it('drops malicious theme values inside the shadow root', async () => {
    const element = document.createElement(ACCOUNT_ELEMENT_NAME) as IdpnAccountElement;
    element.setAttribute('client-id', 'app-a');
    element.theme = { primary: 'red; } body { display: none', background: 'url(javascript:1)' };
    document.body.appendChild(element);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    const root = element.shadowRoot?.querySelector('.idpn-root') as HTMLElement;
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('');
    expect(root.style.getPropertyValue('--idpn-background')).toBe('');
    expect(root.getAttribute('style')).not.toMatch(/javascript|body/i);
  });

  it('applies properties set after the element is mounted', async () => {
    const element = mount({}, ACCOUNT_ELEMENT_NAME);
    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));

    // An AA-compliant primary: the contract drops palettes that cannot carry white text.
    element.theme = { primary: '#0f766e' };

    await waitFor(() => {
      const root = element.shadowRoot?.querySelector('.idpn-root') as HTMLElement;
      expect(root.style.getPropertyValue('--idpn-primary')).toBe('#0f766e');
    });
  });

  it('derives direction from the locale when dir is absent', async () => {
    const element = mount({ locale: 'en-US' }, ACCOUNT_ELEMENT_NAME);

    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));
    expect(element.shadowRoot?.querySelector('.idpn-root')).toHaveAttribute('dir', 'ltr');
    expect(element.shadowRoot?.querySelector('.idpn-root')).toHaveAttribute('lang', 'en-US');
  });
});

describe('Web Component event contract', () => {
  it('publishes a composed, bubbling idpn:event without a token and still calls onEvent', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ title: 'Forbidden' }, 403)));
    const onEvent = vi.fn();
    const received: CustomEvent[] = [];
    const listener = (event: Event): void => {
      received.push(event as CustomEvent);
    };
    document.addEventListener(IDPN_MFE_EVENT_NAME, listener);

    try {
      const element = document.createElement(ELEMENT) as IdpnUserManagementElement;
      element.setAttribute('client-id', 'app-a');
      // SPA mode: the token lives in memory and must never reach the DOM or an event.
      element.getAccessToken = () => TOKEN;
      element.onEvent = onEvent;
      document.body.appendChild(element);

      await waitFor(() => expect(received).toHaveLength(1));

      const event = received[0] as CustomEvent;
      expect(event.type).toBe(IDPN_MFE_EVENT_NAME);
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      expect(event.target).toBe(element);
      expect(event.detail).toEqual({ type: 'auth:error', code: 'forbidden' });
      expect(onEvent).toHaveBeenCalledWith({ type: 'auth:error', code: 'forbidden' });

      expect(JSON.stringify(event.detail)).not.toContain(TOKEN);
      expect(element.outerHTML).not.toContain(TOKEN);
      expect(document.documentElement.outerHTML).not.toContain(TOKEN);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      expect(document.cookie).toBe('');
    } finally {
      document.removeEventListener(IDPN_MFE_EVENT_NAME, listener);
    }
  });
});

describe('Web Component property updates', () => {
  it('re-renders for the new client when the client-id attribute changes', async () => {
    const element = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(requestedUrls().some((url) => url.includes('/clients/app-a/members'))).toBe(true);

    element.setAttribute('client-id', 'app-b');

    await waitFor(() =>
      expect(requestedUrls().some((url) => url.includes('/clients/app-b/members'))).toBe(true),
    );
    expect(element.getAttribute('client-id')).toBe('app-b');
    expect(element.shadowRoot?.querySelectorAll('.idpn-root')).toHaveLength(1);
  });

  it('switches from user-management to account through the module property', async () => {
    const element = mount();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    element.module = 'account';

    await waitFor(() =>
      expect(requestedUrls().some((url) => url.includes('/api/v1/account/profile'))).toBe(true),
    );
    expect(element.module).toBe('account');
    expect(element.shadowRoot?.querySelector('[data-testid="account-module"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelectorAll('.idpn-root')).toHaveLength(1);
  });

  it('does not re-fetch when only the onEvent property changes', async () => {
    const element = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const callsBefore = fetchMock.mock.calls.length;

    // The module receives a stable dispatcher, so replacing the host handler must not
    // restart the data effects (and must not duplicate listeners).
    element.onEvent = vi.fn();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('keeps a single shadow root and mount point across unmount and re-mount', async () => {
    const element = mount();
    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));

    element.remove();
    document.body.appendChild(element);
    await waitFor(() => expect(element.shadowRoot?.textContent).toContain('سارا محمدی'));

    expect(element.shadowRoot?.querySelectorAll('.idpn-root')).toHaveLength(1);
    expect(element.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
    // Exactly one <style> and one mount point are direct children of the shadow root.
    expect(element.shadowRoot?.children).toHaveLength(2);
  });
});
