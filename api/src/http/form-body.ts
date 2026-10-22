import type { FastifyInstance } from 'fastify';

const FORM_PARSER_FLAG = Symbol.for('idpn.formBodyParser');

interface FlaggedInstance {
  [FORM_PARSER_FLAG]?: true;
}

/**
 * Accepts `application/x-www-form-urlencoded` bodies, the content type RFC 6749 (token) and
 * RFC 7009 (revocation) clients use. JSON bodies stay supported for first-party callers.
 * Safe to call more than once on the same instance.
 */
export function registerFormBodyParser(app: FastifyInstance): void {
  const flagged = app as FastifyInstance & FlaggedInstance;
  if (flagged[FORM_PARSER_FLAG] === true) {
    return;
  }
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      done(null, Object.fromEntries(new URLSearchParams(text).entries()));
    },
  );
  flagged[FORM_PARSER_FLAG] = true;
}
