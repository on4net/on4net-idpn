// @vitest-environment jsdom
import { IDPN_MFE_TAGS } from '@idpn/mfe-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  areElementsRegistered,
  BundleLoadError,
  DEFAULT_BUNDLE_URL,
  loadWebComponentBundle,
} from './bundle-loader';

const bundleScript = (): HTMLScriptElement | null =>
  document.querySelector<HTMLScriptElement>('script[data-idpn-wc-bundle]');

afterEach(() => {
  for (const script of document.querySelectorAll('script[data-idpn-wc-bundle]')) {
    script.remove();
  }
});

describe('loadWebComponentBundle', () => {
  it('adds one module script for the configured URL', async () => {
    const pending = loadWebComponentBundle('/dist-wc/web-component.js');
    const script = bundleScript();

    expect(script).not.toBeNull();
    expect(script?.type).toBe('module');
    expect(script?.getAttribute('src')).toBe('/dist-wc/web-component.js');

    script?.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toBeInstanceOf(BundleLoadError);
  });

  it('rejects with a secret-free message when the script cannot be loaded', async () => {
    const pending = loadWebComponentBundle('/dist-wc/missing.js');
    bundleScript()?.dispatchEvent(new Event('error'));

    await expect(pending).rejects.toThrow(/could not be loaded from \/dist-wc\/missing\.js/);
    await expect(pending).rejects.not.toThrow(/token|bearer/i);
  });

  it('rejects when the script loads without registering the module elements', async () => {
    const pending = loadWebComponentBundle(DEFAULT_BUNDLE_URL);
    bundleScript()?.dispatchEvent(new Event('load'));

    await expect(pending).rejects.toThrow(/did not register the module elements/);
    expect(areElementsRegistered()).toBe(false);
  });

  it('resolves immediately when every element is already registered', async () => {
    for (const tag of Object.values(IDPN_MFE_TAGS)) {
      if (customElements.get(tag) === undefined) {
        customElements.define(tag, class extends HTMLElement {});
      }
    }

    await expect(loadWebComponentBundle('/dist-wc/web-component.js')).resolves.toBeUndefined();
    expect(bundleScript()).toBeNull();
  });
});
