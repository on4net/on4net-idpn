import { idpnThemeToCssVariables, type IdpnTheme } from '@idpn/contracts/theme';
import { Direction } from 'radix-ui';
import * as React from 'react';

/**
 * Portal scope of one `.idpn-root`. `container` is `null` for the single render between
 * the root commit and the portal host ref callback; overlays must wait for it instead of
 * falling back to `document.body`.
 */
export interface PortalScope {
  readonly container: HTMLElement | null;
}

const PortalContainerContext = React.createContext<PortalScope | null>(null);

/** Returns `null` outside an `IdpnRoot` (standalone surfaces such as the admin panel). */
export function usePortalScope(): PortalScope | null {
  return React.useContext(PortalContainerContext);
}

/** Portal target used by Dialog/Select so overlays never attach to `document.body`. */
export function usePortalContainer(): HTMLElement | null {
  return usePortalScope()?.container ?? null;
}

/** Raised when a portalled component is used without a valid portal target. */
export class PortalContainerError extends Error {
  constructor(component: string) {
    super(
      `[idpn] ${component} requires a portal container. Render it inside <IdpnRoot> or ` +
        'pass an explicit `container` element; portalling to document.body is not allowed ' +
        'for MFE surfaces.',
    );
    this.name = 'PortalContainerError';
  }
}

/**
 * Single portal contract for every overlay:
 *
 * - explicit container wins (must be an element, never `null`);
 * - inside `IdpnRoot` the scoped portal host wins, and `null` means "not committed yet",
 *   so the caller renders nothing for one tick instead of leaking to `document.body`;
 * - outside `IdpnRoot` (standalone admin surface) the browser body remains the fallback.
 */
export function resolvePortalTarget(
  explicitContainer: HTMLElement | null | undefined,
  scope: PortalScope | null,
  component: string,
): HTMLElement | null {
  if (explicitContainer === null) {
    throw new PortalContainerError(component);
  }
  if (explicitContainer !== undefined) {
    return explicitContainer;
  }
  if (scope !== null) {
    return scope.container;
  }
  if (typeof document === 'undefined') {
    throw new PortalContainerError(component);
  }
  return document.body;
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
  const portalScope = React.useMemo<PortalScope>(
    () => ({ container: portalContainer }),
    [portalContainer],
  );

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
        <PortalContainerContext.Provider value={portalScope}>
          {children}
        </PortalContainerContext.Provider>
        <div data-testid="idpn-portal-root" data-idpn-portal-root="" ref={setPortalContainer} />
      </div>
    </Direction.Provider>
  );
}
