const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; line-height: 1.6; }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; }
  dl { display: grid; grid-template-columns: 10rem 1fr; gap: 0.25rem 1rem; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  form { display: inline-block; margin-right: 0.5rem; }
  .notice { padding: 0.75rem 1rem; border: 1px solid currentColor; border-radius: 0.5rem; }
`;

export interface PageOptions {
  title: string;
  body: string;
  /** Content-Security-Policy for all pages served by the sample app. */
  nonce?: string;
}

export function renderPage({ title, body }: PageOptions): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main data-testid="bff-page">
      ${body}
    </main>
  </body>
</html>`;
}

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
