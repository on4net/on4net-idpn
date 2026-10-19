/**
 * Version metadata of the published SDK.
 *
 * - `IDPN_MFE_SDK_VERSION` follows Semantic Versioning and must equal `package.json`.
 * - `IDPN_MFE_CONTRACT_VERSION` mirrors `MFE_SCHEMA_VERSION` of `@idpn/contracts`; a
 *   breaking config/event change bumps it and requires a new SDK major.
 */

/** Version of `@idpn/mfe-sdk`; `version.test.ts` keeps it in sync with `package.json`. */
export const IDPN_MFE_SDK_VERSION = '0.1.0';

/** Version of the config/event contract (docs/micro-frontend.md 10). */
export const IDPN_MFE_CONTRACT_VERSION = 1;
