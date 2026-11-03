import { parseServerEnv, type EnvSource, type ServerEnv } from '@idpn/config';

/**
 * Validates the API configuration once, during bootstrap, so an invalid environment
 * aborts startup with an actionable message instead of failing later at runtime.
 */
export function loadApiEnv(source: EnvSource = process.env): ServerEnv {
  return parseServerEnv(source);
}
