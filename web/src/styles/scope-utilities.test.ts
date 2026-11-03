import { describe, expect, it } from 'vitest';

import { scopeUtilitiesToIdpnRoot } from './scope-utilities';

describe('scopeUtilitiesToIdpnRoot', () => {
  it('wraps only the utilities layer in a root scope', () => {
    const css =
      '@layer base{.idpn-root *{all:revert}}@layer utilities{.flex{display:flex}.p-4{padding:1rem}}';

    expect(scopeUtilitiesToIdpnRoot(css)).toBe(
      '@layer base{.idpn-root *{all:revert}}@layer utilities{@scope (.idpn-root){.flex{display:flex}.p-4{padding:1rem}}}',
    );
  });

  it('handles nested at-rules inside the utilities layer', () => {
    const css =
      '@layer utilities{.flex{display:flex}@media (min-width:40rem){.sm\\:grid{display:grid}}}';

    expect(scopeUtilitiesToIdpnRoot(css)).toContain(
      '@scope (.idpn-root){.flex{display:flex}@media (min-width:40rem){.sm\\:grid{display:grid}}}',
    );
  });

  it('leaves CSS without a utilities layer untouched', () => {
    const css = '.idpn-root{--primary:#000}';

    expect(scopeUtilitiesToIdpnRoot(css)).toBe(css);
  });
});
