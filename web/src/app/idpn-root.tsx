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
  children: React.ReactNode;
}

/**
 * Single root of every IdP surface (Hosted UI and MFE): provides direction,
 * locale attributes and a portal host node scoped inside `.idpn-root`.
 */
export function IdpnRoot({ locale, dir, children }: IdpnRootProps) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);

  return (
    <Direction.Provider dir={dir}>
      <div
        className="idpn-root"
        dir={dir}
        lang={locale}
        data-testid="idpn-root"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}
      >
        <PortalContainerContext.Provider value={portalContainer}>
          {children}
        </PortalContainerContext.Provider>
        <div data-testid="idpn-portal-root" ref={setPortalContainer} />
      </div>
    </Direction.Provider>
  );
}
