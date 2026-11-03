import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdpnReactModuleProps } from '@idpn/mfe-sdk';

import { IdpnModuleHost, type RemoteLoader } from './IdpnModuleHost';

const loginUrl = 'https://auth.example.com/oauth2/authorize';

const moduleProps: IdpnReactModuleProps = {
  clientId: 'app-a',
  locale: 'fa-IR',
  dir: 'rtl',
};

function StubRemote(props: IdpnReactModuleProps) {
  return (
    <div
      data-testid="remote"
      data-client-id={props.clientId}
      data-locale={props.locale}
      data-dir={props.dir}
    />
  );
}

function BrokenRemote(): never {
  throw new Error('remote render failed');
}

const resolveWith =
  (component: React.ComponentType<IdpnReactModuleProps>): RemoteLoader =>
  () =>
    Promise.resolve({ default: component });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IdpnModuleHost', () => {
  it('shows an accessible loading state with the hosted fallback link', () => {
    const pending: RemoteLoader = () => new Promise(() => undefined);

    render(
      <IdpnModuleHost
        module="account"
        load={pending}
        moduleProps={moduleProps}
        loginUrl={loginUrl}
      />,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading the Account module…');
    expect(screen.getByRole('link', { name: 'Open the hosted account page' })).toHaveAttribute(
      'href',
      loginUrl,
    );
  });

  it('mounts the remote with the configured props', async () => {
    render(
      <IdpnModuleHost
        module="account"
        load={resolveWith(StubRemote)}
        moduleProps={moduleProps}
        loginUrl={loginUrl}
      />,
    );

    const remote = await screen.findByTestId('remote');
    expect(remote).toHaveAttribute('data-client-id', 'app-a');
    expect(remote).toHaveAttribute('data-locale', 'fa-IR');
    expect(remote).toHaveAttribute('data-dir', 'rtl');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('falls back to the hosted page when the remote cannot be loaded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: RemoteLoader = () => Promise.reject(new Error('remote offline'));

    render(
      <IdpnModuleHost
        module="user-management"
        load={failing}
        moduleProps={moduleProps}
        loginUrl={loginUrl}
      />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The User management module is unavailable.');
    expect(
      screen.getByRole('link', { name: 'Open the hosted user management page' }),
    ).toHaveAttribute('href', loginUrl);
    expect(consoleError).toHaveBeenCalledWith('[idpn-host] user-management module failed to load');
  });

  it('contains a rendering crash inside the remote boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <IdpnModuleHost
        module="account"
        load={resolveWith(BrokenRemote)}
        moduleProps={moduleProps}
        loginUrl={loginUrl}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Account module is unavailable.',
    );
  });

  it('unmounts cleanly and mounts again without duplicating the remote', async () => {
    const view = render(
      <IdpnModuleHost
        module="account"
        load={resolveWith(StubRemote)}
        moduleProps={moduleProps}
        loginUrl={loginUrl}
      />,
    );
    await screen.findByTestId('remote');

    view.unmount();
    expect(screen.queryByTestId('remote')).toBeNull();

    render(
      <IdpnModuleHost
        module="account"
        load={resolveWith(StubRemote)}
        moduleProps={moduleProps}
        loginUrl={loginUrl}
      />,
    );
    expect(await screen.findAllByTestId('remote')).toHaveLength(1);
  });
});
