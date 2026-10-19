import { idpnThemeToCssVariables, type IdpnTheme } from '@idpn/contracts/theme';
import { Direction } from 'radix-ui';
import * as React from 'react';

const PortalContainerContext = React.createContext<HTMLElement | null>(null);

/** Portal target used by Dialog/Select so overlays never attach to `document.body`. */
export function usePortalContainer(): HTMLElement | null {
  return React.useContext(PortalContainerContext);
}

export interface IdpnRootProps {
  locale: string;
  dir: 'rtl' | 'ltr';
  /** Client theme tokens; sanitized before they become CSS variables (docs/design-system.md 5). */
  theme?: IdpnTheme;
  /** Applies the `dark` class so `.idpn-root.dark` picks the client's dark overrides. */
  dark?: boolean;
  children: React.ReactNode;
  'data-client-id'?: string;
  'aria-busy'?: boolean;
}

/**
 * Single root of every IdP surface (Hosted UI and MFE): provides direction,
 * locale attributes, client theme tokens and a portal host node scoped inside `.idpn-root`.
 *
 * Theme values never reach the DOM raw: `idpnThemeToCssVariables` accepts only the
 * documented semantic tokens with well-formed color/length/font values and emits
 * `--idpn-*` custom properties. Semantic shadcn variables are assigned from those
 * properties inside `globals.css`, so `:root` is never touched and several clients can
 * coexist on one page.
 */
export function IdpnRoot({ locale, dir, theme, dark = false, children, ...rest }: IdpnRootProps) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);

  const style = React.useMemo(() => {
    const tokens: Record<string, string> = {
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: '2rem',
      ...idpnThemeToCssVariables(theme, { dir }),
    };
    return tokens as React.CSSProperties;
  }, [theme, dir]);

  return (
    <Direction.Provider dir={dir}>
      <div
        className={dark ? 'idpn-root dark' : 'idpn-root'}
        dir={dir}
        lang={locale}
        data-testid="idpn-root"
        data-idpn-theme=""
        data-client-id={rest['data-client-id']}
        aria-busy={rest['aria-busy']}
        style={style}
      >
        <PortalContainerContext.Provider value={portalContainer}>
          {children}
        </PortalContainerContext.Provider>
        <div data-testid="idpn-portal-root" ref={setPortalContainer} />
      </div>
    </Direction.Provider>
  );
}
