// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdpnEvent, IdpnMfeConfig } from './contract.js';
import {
  IDPN_MFE_MARKER_ATTRIBUTE,
  IDPN_MFE_TAGS,
  mountIdpnModule,
  unmountIdpnModule,
  type IdpnMfeElement,
} from './mount.js';

/**
 * Stand-in for the real Web Component. It records the properties the SDK assigns and can
 * emit a module event, so the helper is tested without bundling React or @idpn/web.
 */
class StubElement extends HTMLElement {
  getAccessToken?: () => string | null;
  onEvent?: (event: IdpnEvent) => void;
  theme?: Record<string, string>;

  emit(event: IdpnEvent): void {
    this.onEvent?.(event);
  }
}

const defineStubs = (): void => {
  for (const tag of Object.values(IDPN_MFE_TAGS)) {
    if (customElements.get(tag) === undefined) {
      customElements.define(tag, class extends StubElement {});
    }
  }
};

const config = (overrides: Partial<IdpnMfeConfig> = {}): IdpnMfeConfig => ({
  clientId: 'app-a',
  module: 'user-management',
  mode: 'bff',
  apiBaseUrl: '/auth',
  locale: 'fa-IR',
  dir: 'rtl',
  ...overrides,
});

let container: HTMLElement;

beforeEach(() => {
  defineStubs();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const mountedElement = (handle: { element: IdpnMfeElement }): StubElement =>
  handle.element as StubElement;

describe('mountIdpnModule', () => {
  it('creates the user-management element with non-sensitive attributes', () => {
    const mounted = mountIdpnModule(container, config());

    expect(container.children).toHaveLength(1);
    expect(mounted.element.tagName.toLowerCase()).toBe('on4net-idpn-user-management');
    expect(mounted.element.getAttribute('client-id')).toBe('app-a');
    expect(mounted.element.getAttribute('api-base')).toBe('/auth');
    expect(mounted.element.getAttribute('locale')).toBe('fa-IR');
    expect(mounted.element.getAttribute('dir')).toBe('rtl');
    expect(mounted.element.hasAttribute(IDPN_MFE_MARKER_ATTRIBUTE)).toBe(true);
  });

  it('creates the account element for the account module', () => {
    const mounted = mountIdpnModule(container, config({ module: 'account' }));

    expect(mounted.element.tagName.toLowerCase()).toBe('on4net-idpn-account');
    expect(mounted.element.getAttribute('client-id')).toBe('app-a');
  });

  it('normalizes the locale and derives the direction from the locales config', () => {
    const mounted = mountIdpnModule(
      container,
      config({
        locale: 'en',
        dir: undefined,
        locales: {
          default: 'fa-IR',
          supported: ['fa-IR', 'en-US'],
          dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
        },
      }),
    );

    expect(mounted.element.getAttribute('locale')).toBe('en-US');
    expect(mounted.element.getAttribute('dir')).toBe('ltr');
    expect((mountedElement(mounted) as unknown as { locales?: unknown }).locales).toEqual({
      default: 'fa-IR',
      supported: ['fa-IR', 'en-US'],
      dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
    });
  });

  it('falls back to the client default when the requested locale is unsupported', () => {
    const mounted = mountIdpnModule(
      container,
      config({
        locale: 'de-DE',
        dir: undefined,
        locales: {
          default: 'en-US',
          supported: ['en-US'],
          dir: { 'en-US': 'ltr' },
        },
      }),
    );

    expect(mounted.element.getAttribute('locale')).toBe('en-US');
    expect(mounted.element.getAttribute('dir')).toBe('ltr');
  });

  it('keeps the token getter and event handler in memory, never in attributes', () => {
    const getAccessToken = () => 'secret-access-token';
    const onEvent = vi.fn();
    const mounted = mountIdpnModule(container, config({ mode: 'spa', getAccessToken, onEvent }));

    const element = mountedElement(mounted);
    expect(element.getAccessToken?.()).toBe('secret-access-token');
    expect(element.onEvent).toBe(onEvent);

    const attributes = Array.from(element.attributes).map((attribute) => attribute.name);
    expect(attributes.sort()).toEqual(
      ['api-base', 'client-id', 'data-idpn-mfe', 'dir', 'locale'].sort(),
    );
    expect(element.outerHTML).not.toContain('secret-access-token');
    expect(element.outerHTML).not.toContain('function');
  });

  it('delivers events through the in-memory handler without a token', () => {
    const onEvent = vi.fn();
    const mounted = mountIdpnModule(container, config({ onEvent }));
    const event: IdpnEvent = { type: 'locale:changed', locale: 'en-US', dir: 'ltr' };

    mountedElement(mounted).emit(event);

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(JSON.stringify(onEvent.mock.calls)).not.toMatch(/token/i);
    expect(mounted.element.outerHTML).not.toContain('locale:changed');
  });

  it('clears the token getter in bff mode even when the host provides one', () => {
    const mounted = mountIdpnModule(
      container,
      config({ mode: 'bff', getAccessToken: () => 'never-used' }),
    );

    expect(mountedElement(mounted).getAccessToken).toBeUndefined();
  });

  it('forwards theme tokens as an in-memory property', () => {
    const mounted = mountIdpnModule(
      container,
      config({ theme: { primary: '#0057b8', radius: '0.75rem' } }),
    );

    expect(mountedElement(mounted).theme).toEqual({ primary: '#0057b8', radius: '0.75rem' });
    expect(mounted.element.outerHTML).not.toContain('#0057b8');
  });

  it('replaces another module when a new module is mounted in the container', () => {
    mountIdpnModule(container, config());
    const mounted = mountIdpnModule(container, config({ module: 'account' }));

    expect(mounted.element.tagName.toLowerCase()).toBe('on4net-idpn-account');
    expect(container.querySelectorAll('[data-idpn-mfe]')).toHaveLength(1);
  });

  it('updates the existing element instead of duplicating it', () => {
    const first = mountIdpnModule(container, config());
    const firstElement = first.element;

    const second = mountIdpnModule(container, config({ clientId: 'app-b' }));

    expect(container.children).toHaveLength(1);
    expect(second.element).toBe(firstElement);
    expect(second.element.getAttribute('client-id')).toBe('app-b');
  });

  it('updates attributes and removes optional ones when they disappear', () => {
    const mounted = mountIdpnModule(container, config());
    const element = mounted.element;

    mounted.update(
      config({
        clientId: 'app-b',
        locale: 'en-US',
        dir: 'ltr',
        apiBaseUrl: 'https://api.example.com/auth',
      }),
    );
    expect(mounted.element).toBe(element);
    expect(element.getAttribute('client-id')).toBe('app-b');
    expect(element.getAttribute('api-base')).toBe('https://api.example.com/auth');
    expect(element.getAttribute('locale')).toBe('en-US');
    expect(element.getAttribute('dir')).toBe('ltr');

    mounted.update({
      clientId: 'app-b',
      module: 'user-management',
      mode: 'bff',
      apiBaseUrl: '/auth',
    });
    expect(element.hasAttribute('locale')).toBe(false);
    expect(element.hasAttribute('dir')).toBe(false);
  });

  it('switches the custom element when the module changes', () => {
    const mounted = mountIdpnModule(
      container,
      config({ mode: 'spa', getAccessToken: () => 'token-1' }),
    );
    const previous = mountedElement(mounted);

    mounted.update(config({ module: 'account', mode: 'spa' }));

    expect(mounted.element.tagName.toLowerCase()).toBe('on4net-idpn-account');
    expect(mounted.element).not.toBe(previous);
    expect(previous.isConnected).toBe(false);
    expect(previous.getAccessToken).toBeUndefined();
    expect(container.querySelectorAll('[data-idpn-mfe]')).toHaveLength(1);
  });

  it('unmounts cleanly and releases in-memory handlers', () => {
    const onEvent = vi.fn();
    const mounted = mountIdpnModule(
      container,
      config({ mode: 'spa', getAccessToken: () => 'token-1', onEvent }),
    );
    const element = mountedElement(mounted);

    unmountIdpnModule(mounted);

    expect(container.children).toHaveLength(0);
    expect(element.getAccessToken).toBeUndefined();
    expect(element.onEvent).toBeUndefined();
    expect(element.theme).toBeUndefined();
  });

  it('does not remove elements the host created itself', () => {
    const hostOwned = document.createElement('div');
    container.appendChild(hostOwned);
    const mounted = mountIdpnModule(container, config());

    mounted.unmount();

    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(hostOwned);
  });

  it('requires a DOM container', () => {
    expect(() => mountIdpnModule(null as unknown as Element, config())).toThrow(TypeError);
    expect(() => mountIdpnModule({} as Element, config())).toThrow(
      'mountIdpnModule requires a DOM element as the mount container.',
    );
  });

  it('fails in a non-DOM environment', () => {
    vi.stubGlobal('document', undefined);

    expect(() => mountIdpnModule(container, config())).toThrow(
      'mountIdpnModule requires a DOM environment; mount it on the client.',
    );
  });
});

describe('mountIdpnModule config validation', () => {
  const invalid: [string, IdpnMfeConfig][] = [
    ['clientId is empty', config({ clientId: '  ' })],
    ['module is unknown', config({ module: 'login' as never })],
    ['mode is unknown', config({ mode: 'hybrid' as never })],
    ['apiBaseUrl is empty', config({ apiBaseUrl: '' })],
    ['locale is empty', config({ locale: '' })],
    ['dir is unknown', config({ dir: 'up' as never })],
    ['getAccessToken is not a function', config({ getAccessToken: 'token' as never })],
    ['onEvent is not a function', config({ onEvent: {} as never })],
    ['theme is null', config({ theme: null as never })],
    [
      'locales default is invalid',
      config({ locales: { default: '<x>', supported: ['fa-IR'], dir: {} } }),
    ],
    [
      'locales supported is empty',
      config({ locales: { default: 'fa-IR', supported: [], dir: {} } }),
    ],
    [
      'locales supported contains duplicates',
      config({
        locales: { default: 'fa-IR', supported: ['fa-IR', 'fa-ir'], dir: { 'fa-IR': 'rtl' } },
      }),
    ],
    [
      'locales dir is invalid',
      config({
        locales: {
          default: 'fa-IR',
          supported: ['fa-IR'],
          dir: { 'fa-IR': 'up' as never },
        },
      }),
    ],
    ['accessToken is passed in config', { ...config(), accessToken: 'secret' } as IdpnMfeConfig],
    ['refreshToken is passed in config', { ...config(), refreshToken: 'secret' } as IdpnMfeConfig],
    ['clientSecret is passed in config', { ...config(), clientSecret: 'secret' } as IdpnMfeConfig],
  ];

  for (const [name, value] of invalid) {
    it(`rejects config where ${name}`, () => {
      expect(() => mountIdpnModule(container, value)).toThrow(TypeError);
      expect(container.children).toHaveLength(0);
    });
  }

  it('rejects config that is not an object', () => {
    expect(() => mountIdpnModule(container, null as never)).toThrow(
      'IdpnMfeConfig must be an object.',
    );
  });

  it('rejects an invalid config during update without touching the mounted element', () => {
    const mounted = mountIdpnModule(container, config());

    expect(() => mounted.update(config({ clientId: '' }))).toThrow(TypeError);
    expect(mounted.element.getAttribute('client-id')).toBe('app-a');
  });
});
