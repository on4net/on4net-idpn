import type { Plugin } from 'vite';

const UTILITIES_LAYER = '@layer utilities{';

/**
 * Tailwind emits utilities globally. For the Module Federation build that is enough to
 * style host elements that happen to use the same generic class names (`flex`, `p-4`, …).
 * Wrap only the utilities layer in `@scope (.idpn-root)` so every generated utility is
 * limited to descendants of the module root. Tokens and the scoped reset are already
 * root-scoped, and the Web Component build does not need this transform (Shadow DOM).
 *
 * The transform runs on already-generated CSS, so it only needs to find the brace that
 * closes the utilities layer.
 */
export function scopeUtilitiesToIdpnRoot(css: string, scopeSelector = '.idpn-root'): string {
  const layerIndex = css.indexOf(UTILITIES_LAYER);
  if (layerIndex === -1) {
    return css;
  }

  const bodyStart = layerIndex + UTILITIES_LAYER.length;
  let depth = 1;

  for (let index = bodyStart; index < css.length; index += 1) {
    const character = css[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = css.slice(bodyStart, index);
        return `${css.slice(0, bodyStart)}@scope (${scopeSelector}){${body}}${css.slice(index)}`;
      }
    }
  }

  return css;
}

/** Vite plugin used by the federated remote build (`vite.mfe.config.ts`). */
export function idpnScopeUtilities(): Plugin {
  return {
    name: 'idpn-scope-utilities',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type === 'asset' && asset.fileName.endsWith('.css')) {
          if (typeof asset.source === 'string') {
            asset.source = scopeUtilitiesToIdpnRoot(asset.source);
          }
        }
      }
    },
  };
}
