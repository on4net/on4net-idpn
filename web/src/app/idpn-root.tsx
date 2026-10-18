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
  /** Client theme tokens mapped to CSS variables (docs/design-system.md 5). */
  theme?: Record<string, string>;
  children: React.ReactNode;
  'data-client-id'?: string;
  'aria-busy'?: boolean;
}

/**
 * Single root of every IdP surface (Hosted UI and MFE): provides direction,
 * locale attributes, client theme tokens and a portal host node scoped inside `.idpn-root`.
 */
export function IdpnRoot({ locale, dir, theme = {}, children, ...rest }: IdpnRootProps) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);

  const style = React.useMemo(() => {
    const tokens: Record<string, string> = {
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: '2rem',
    };
    for (const [name, value] of Object.entries(theme)) {
      tokens[`--${name}`] = value;
      tokens[`--idpn-${name}`] = value;
    }
    return tokens as React.CSSProperties;
  }, [theme]);

  return (
    <Direction.Provider dir={dir}>
      <div
        className="idpn-root"
        dir={dir}
        lang={locale}
        data-testid="idpn-root"
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
