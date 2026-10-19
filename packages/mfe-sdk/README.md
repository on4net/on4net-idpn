# @idpn/mfe-sdk

Typed contract and non-React mount helpers for the on4net IDPN micro-frontends
(`user-management` and `account`).

The package has **no runtime dependencies**, no globals, no storage and no React import.
React hosts use the Module Federation remotes and import only the types; every other host
loads the Web Component bundle and uses `mountIdpnModule` / `unmountIdpnModule`.

Full documentation: [`docs/mfe-sdk.md`](../../docs/mfe-sdk.md).

## Install

```bash
pnpm add @idpn/mfe-sdk@^0.1.0
```

The Web Component bundle is published separately (Versioned remote):

```html
<script type="module" src="https://cdn.example.com/idpn-mfe/1.4.0/web-component.js"></script>
```

## Usage (Web Component hosts)

```ts
import { mountIdpnModule } from '@idpn/mfe-sdk';

const mounted = mountIdpnModule(document.querySelector('#idpn-account')!, {
  clientId: 'app-a',
  module: 'account',
  mode: 'bff',
  apiBaseUrl: '/auth',
  locale: 'fa-IR',
  dir: 'rtl',
  theme: { brand: '#0057b8' },
  onEvent: (event) => {
    if (event.type === 'auth:error') console.warn(event.code);
  },
});

// Later
mounted.update({ ...mountedConfig, locale: 'en-US', dir: 'ltr' });
mounted.unmount();
```

`mountIdpnModule` creates `<on4net-idpn-user-management>` or `<on4net-idpn-account>`
inside the container. A second call for the same container updates the existing element
instead of duplicating it. `unmount()` clears the in-memory handlers and removes the
element.

## Configuration

| Field            | Required | Notes                                                                               |
| ---------------- | -------- | ----------------------------------------------------------------------------------- |
| `clientId`       | yes      | Public client id registered in the IdP; host configuration, never user input.       |
| `module`         | yes      | `user-management` or `account`.                                                     |
| `mode`           | yes      | `bff` (recommended) or `spa` (trusted hosts only).                                  |
| `apiBaseUrl`     | yes      | Host `/auth` prefix (BFF) or IdP API origin (SPA).                                  |
| `locale` / `dir` | no       | BCP 47 locale and `rtl` / `ltr`; direction is derived from the locale when omitted. |
| `theme`          | no       | CSS custom properties mapped to `--<name>` / `--idpn-<name>`.                       |
| `getAccessToken` | SPA only | In-memory getter; cleared automatically in BFF mode. Never an attribute.            |
| `onEvent`        | no       | Receives `IdpnEvent`; never contains a token.                                       |

`loginUrl`, `locales`, `loginContext`, `basename` and `features` are part of the shared
contract for Module Federation hosts; the Web Component helper does not forward them.

## Security

- **BFF (default):** the host BFF holds the tokens and the browser sends only a session
  cookie to `/auth/*`. Pass `mode: 'bff'` and never provide a token getter.
- **SPA (trusted hosts only):** provide an in-memory `getAccessToken`; the SDK never
  writes it to attributes, DOM, events, `localStorage` or `sessionStorage`.
- `clientId` and `apiBaseUrl` are configuration, never user input. Server-side
  authorization remains authoritative.
- The SDK rejects configs that contain `accessToken`, `refreshToken`, `idToken`, `token`
  or `clientSecret`.
- No login form is embedded: sign-in is always a top-level redirect to the Hosted UI.
- The Web Component renders into a Shadow DOM and only accepts theme tokens, so host CSS
  cannot leak in or out.

## Versioning

- Semantic Versioning; breaking config/event changes require a new major.
- `IDPN_MFE_SDK_VERSION` equals `package.json`; `IDPN_MFE_CONTRACT_VERSION` mirrors
  `MFE_SCHEMA_VERSION` from `@idpn/contracts`.
- `src/contract.test.ts` validates every event against the contract schema and fails on
  drift; `src/version.test.ts` keeps the packaged version honest.
- Remotes are immutable and pinned by major:
  `https://cdn.example.com/idpn-mfe/{version}/remoteEntry.js`; discovery through
  `https://cdn.example.com/idpn-mfe/manifest.json`.
- Deprecations are announced at least two minor releases before removal; the previous
  release stays on the CDN for rollback.

## Development

```bash
pnpm --filter @idpn/mfe-sdk run typecheck
pnpm --filter @idpn/mfe-sdk run test
pnpm --filter @idpn/mfe-sdk run test:coverage
pnpm --filter @idpn/mfe-sdk run build
```
