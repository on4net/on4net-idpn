import * as React from 'react';
import type { IdpnMfeModule, IdpnReactModuleProps } from '@idpn/mfe-sdk';

import { MODULE_LABEL } from './host-config';

/**
 * A remote exposed through Module Federation. The default export is the module root,
 * which owns `.idpn-root`, direction and the portal container.
 */
export interface RemoteModule {
  readonly default: React.ComponentType<IdpnReactModuleProps>;
}

export type RemoteLoader = () => Promise<RemoteModule>;

type FallbackReason = 'loading' | 'failed';

interface HostedFallbackProps {
  module: IdpnMfeModule;
  loginUrl: string;
  reason: FallbackReason;
}

/**
 * The documented graceful-degradation path (docs/micro-frontend.md 4.4): while the remote
 * loads, and when it cannot be loaded at all, the host offers the Hosted page on the IdP
 * origin instead of rendering an embedded login form.
 */
function HostedFallback({ module, loginUrl, reason }: HostedFallbackProps) {
  const label = MODULE_LABEL[module];
  const loading = reason === 'loading';

  return (
    <div
      className={loading ? 'idpn-host-fallback' : 'idpn-host-fallback idpn-host-fallback--error'}
      role={loading ? 'status' : 'alert'}
      aria-live={loading ? 'polite' : 'assertive'}
      aria-busy={loading ? true : undefined}
      data-testid={loading ? `idpn-${module}-loading` : `idpn-${module}-fallback`}
    >
      <p className="idpn-host-fallback__title">
        {loading ? `Loading the ${label} module…` : `The ${label} module is unavailable.`}
      </p>
      {loading ? null : (
        <p className="idpn-host-fallback__text">
          Nothing was lost. Continue on the hosted page hosted by the identity provider.
        </p>
      )}
      <a
        className="idpn-host-fallback__link"
        href={loginUrl}
        data-testid={`idpn-${module}-fallback-link`}
      >
        Open the hosted {label.toLowerCase()} page
      </a>
    </div>
  );
}

interface RemoteErrorBoundaryProps {
  module: IdpnMfeModule;
  loginUrl: string;
  children: React.ReactNode;
}

interface RemoteErrorBoundaryState {
  failed: boolean;
}

/**
 * Catches both a rejected `React.lazy` import (remote unreachable, CSP block, version
 * mismatch) and a render crash inside the remote. The remote is third-party code from the
 * host's point of view, so one broken module must not take the whole app down.
 */
class RemoteErrorBoundary extends React.Component<
  RemoteErrorBoundaryProps,
  RemoteErrorBoundaryState
> {
  override state: RemoteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RemoteErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // Deliberately logs no error payload: the error object can contain remote internals
    // and the host only needs to know which module failed.
    console.error(`[idpn-host] ${this.props.module} module failed to load`);
  }

  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <HostedFallback module={this.props.module} loginUrl={this.props.loginUrl} reason="failed" />
      );
    }
    return this.props.children;
  }
}

export interface IdpnModuleHostProps {
  module: IdpnMfeModule;
  load: RemoteLoader;
  /** Props built from the host config by `toModuleProps`. */
  moduleProps: IdpnReactModuleProps;
  /** Hosted page offered while loading and after a failure. */
  loginUrl: string;
}

/**
 * Lazy, isolated mount point for one federated module.
 *
 * React is a singleton shared through Module Federation, so `React.lazy`/`Suspense` work
 * across the boundary. Each module gets its own boundary: a failure in `account` leaves
 * `user-management` mounted.
 */
export function IdpnModuleHost({ module, load, moduleProps, loginUrl }: IdpnModuleHostProps) {
  const RemoteComponent = React.useMemo(
    () =>
      React.lazy(async () => {
        const remote = await load();
        return { default: remote.default };
      }),
    [load],
  );

  return (
    <div className="idpn-host-slot" data-idpn-module={module}>
      <RemoteErrorBoundary module={module} loginUrl={loginUrl}>
        <React.Suspense
          fallback={<HostedFallback module={module} loginUrl={loginUrl} reason="loading" />}
        >
          <RemoteComponent {...moduleProps} />
        </React.Suspense>
      </RemoteErrorBoundary>
    </div>
  );
}
