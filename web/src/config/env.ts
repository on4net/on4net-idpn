import { parsePublicEnv, type EnvSource, type PublicEnv } from '@idpn/config';

/**
 * Validates the configuration exposed to the browser bundle. Call it once during
 * app bootstrap; Vite only exposes `VITE_`-prefixed variables.
 */
export function loadWebEnv(source: EnvSource = import.meta.env): PublicEnv {
  return parsePublicEnv(source);
}
