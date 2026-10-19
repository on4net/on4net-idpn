import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdpnUserManagementElement } from './web-component';

const ELEMENT = 'on4net-idpn-user-management';

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return Promise.resolve(
      url.includes('/api/v1/roles') ? jsonResponse(rolesBody) : jsonResponse(membersBody),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const mount = (attributes: Record<string, string> = {}) => {
  const element = document.createElement(ELEMENT) as IdpnUserManagementElement;
  element.setAttribute('client-id', 'app-a');
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  return element;
};

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
