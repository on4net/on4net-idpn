import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdpnMfeModule, IdpnReactModuleProps } from '@idpn/mfe-sdk';
import * as React from 'react';

import { HostApp } from './HostApp';
import { parseHostConfig } from './host-config';
import type { RemoteLoader } from './IdpnModuleHost';

function UserManagementRemote(props: IdpnReactModuleProps) {
  return <div data-testid="remote-user-management" data-client-id={props.clientId} />;
}

function AccountRemote(props: IdpnReactModuleProps) {
  return <div data-testid="remote-account" data-client-id={props.clientId} />;
}

function ErroringAccountRemote(props: IdpnReactModuleProps) {
  const { onEvent } = props;
  React.useEffect(() => {
    onEvent?.({ type: 'auth:error', code: 'forbidden' });
  }, [onEvent]);
  return <div data-testid="remote-account" />;
}

const loaders: Record<IdpnMfeModule, RemoteLoader> = {
  'user-management': () => Promise.resolve({ default: UserManagementRemote }),
  account: () => Promise.resolve({ default: AccountRemote }),
};

const erroringLoaders: Record<IdpnMfeModule, RemoteLoader> = {
  'user-management': () => Promise.resolve({ default: UserManagementRemote }),
  account: () => Promise.resolve({ default: ErroringAccountRemote }),
};

const config = parseHostConfig({
  VITE_IDPN_CLIENT_ID: 'app-a',
  VITE_IDPN_LOGIN_CONTEXT: 'admin',
  VITE_IDPN_THEME: '{"primary":"#0057b8"}',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HostApp', () => {
  it('renders the host configuration, never user input', () => {
    render(<HostApp config={config} loaders={loaders} />);

    expect(screen.getByTestId('idpn-host-client-id')).toHaveTextContent('app-a');
    expect(screen.getByTestId('idpn-host-mode')).toHaveTextContent('bff');
    expect(screen.getByTestId('idpn-host-login-context')).toHaveTextContent('admin');
    expect(screen.getByTestId('idpn-host-locale')).toHaveTextContent('fa-IR (rtl)');
  });

  it('mounts every configured module with the configured client id', async () => {
    render(<HostApp config={config} loaders={loaders} />);

    expect(await screen.findByTestId('remote-user-management')).toHaveAttribute(
      'data-client-id',
      'app-a',
    );
    expect(await screen.findByTestId('remote-account')).toHaveAttribute('data-client-id', 'app-a');
    expect(screen.getByTestId('idpn-host-slot-user-management')).toBeInTheDocument();
    expect(screen.getByTestId('idpn-host-slot-account')).toBeInTheDocument();
  });

  it('only renders the selected module', async () => {
    const accountOnly = parseHostConfig({
      VITE_IDPN_CLIENT_ID: 'app-a',
      VITE_IDPN_MODULE: 'account',
    });

    render(<HostApp config={accountOnly} loaders={loaders} />);

    expect(await screen.findByTestId('remote-account')).toBeInTheDocument();
    expect(screen.queryByTestId('idpn-host-slot-user-management')).toBeNull();
  });

  it('keeps a working module mounted when the other remote fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const isolated: Record<IdpnMfeModule, RemoteLoader> = {
      'user-management': () => Promise.reject(new Error('remote offline')),
      account: () => Promise.resolve({ default: AccountRemote }),
    };

    render(<HostApp config={config} loaders={isolated} />);

    expect(await screen.findByTestId('remote-account')).toBeInTheDocument();
    expect(await screen.findByTestId('idpn-user-management-fallback')).toBeInTheDocument();
  });

  it('surfaces an auth:error event accessibly and logs it to the host sink', async () => {
    const onEvent = vi.fn();
    render(<HostApp config={config} loaders={erroringLoaders} onEvent={onEvent} />);

    const alert = await screen.findByTestId('idpn-host-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('idpn-host-error-code')).toHaveTextContent('forbidden');
    expect(onEvent).toHaveBeenCalledWith({ type: 'auth:error', code: 'forbidden' });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('idpn-host-error')).toBeNull();
  });
});
