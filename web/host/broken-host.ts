import { bootstrapHost } from './host-bootstrap';

/**
 * Fallback fixture (E2E only): the configured bundle URL does not exist, so the host must
 * render its accessible error surface with the Hosted UI link instead of failing silently.
 */
void bootstrapHost({ bundleUrl: '/host/missing-web-component.js' });
