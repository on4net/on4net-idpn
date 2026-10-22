import { IDPN_MFE_TAGS } from '@idpn/mfe-sdk';

/**
 * Where `pnpm --filter @idpn/web run build:wc` writes the bundle in this repository.
 * Production hosts load the version-pinned CDN URL instead
 * (`https://cdn.example.com/idpn-mfe/{version}/web-component.js`) and allowlist that
 * origin in `script-src` (docs/mfe-sdk.md 7).
 */
export const DEFAULT_BUNDLE_URL = '/dist-wc/web-component.js';

/** Raised when the bundle cannot be fetched or does not register the module elements. */
export class BundleLoadError extends Error {
  override readonly name = 'BundleLoadError';
}

/** True when every module tag from the SDK is already registered. */
export function areElementsRegistered(): boolean {
  return Object.values(IDPN_MFE_TAGS).every((tag) => customElements.get(tag) !== undefined);
}

/**
 * Loads the Web Component bundle and waits until the custom elements are registered.
 *
 * The bundle is an ES module, so the browser guarantees that it was evaluated before the
 * `load` event fires. Registration is verified afterwards instead of awaiting
 * `customElements.whenDefined`, which never settles when the bundle is blocked by CSP or
 * silently fails to register.
 *
 * @throws {BundleLoadError} when the script fails to load or does not register the tags.
 */
export async function loadWebComponentBundle(url: string): Promise<void> {
  if (typeof customElements === 'undefined') {
    throw new BundleLoadError(
      'The IDPN Web Component bundle requires a browser with Custom Elements support.',
    );
  }
  if (areElementsRegistered()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = url;
    script.dataset.idpnWcBundle = '';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () =>
        reject(
          new BundleLoadError(`The IDPN Web Component bundle could not be loaded from ${url}.`),
        ),
      { once: true },
    );
    document.head.append(script);
  });

  if (!areElementsRegistered()) {
    throw new BundleLoadError(
      'The IDPN Web Component bundle loaded but did not register the module elements.',
    );
  }
}
