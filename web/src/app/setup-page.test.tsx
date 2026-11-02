import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdpnRoot } from './idpn-root';
import { SetupPage, type SetupPageProps, type SetupResult, type SetupStatus } from './setup-page';

const PASSWORD = 'correct horse battery staple';

function renderSetup(overrides: Partial<SetupPageProps> = {}) {
  const props: SetupPageProps = {
    locale: 'en-US',
    loadStatus: vi.fn().mockResolvedValue('open' satisfies SetupStatus),
    verifyToken: vi.fn().mockResolvedValue({ ok: true } satisfies SetupResult),
    complete: vi.fn().mockResolvedValue({ ok: true } satisfies SetupResult),
    ...overrides,
  };
  render(
    <IdpnRoot locale="en-US" dir="ltr">
      <SetupPage {...props} />
    </IdpnRoot>,
  );
  return props;
}

async function passToken(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Setup token'), 'the-token');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

async function fillAdmin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Full name'), 'Root Admin');
  await user.type(screen.getByLabelText('Username'), 'root.admin');
  await user.type(screen.getByLabelText('Email'), 'root@example.com');
  await user.type(screen.getByLabelText('New password'), PASSWORD);
  await user.type(screen.getByLabelText('Confirm password'), PASSWORD);
}

describe('SetupPage', () => {
  it('shows a closed notice and no form once the instance is installed', async () => {
    const props = renderSetup({ loadStatus: vi.fn().mockResolvedValue('installed') });

    expect(await screen.findByTestId('setup-installed')).toHaveTextContent('Already set up');
    expect(screen.queryByLabelText('Setup token')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(props.verifyToken).not.toHaveBeenCalled();
  });

  it('reports an unreachable API instead of offering the form', async () => {
    renderSetup({ loadStatus: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(await screen.findByTestId('setup-unavailable')).toBeVisible();
    expect(screen.queryByLabelText('Setup token')).toBeNull();
  });

  it('keeps the form locked behind a valid token', async () => {
    const verifyToken = vi.fn().mockResolvedValue({ ok: false, error: 'invalid_token' });
    renderSetup({ verifyToken });
    const user = userEvent.setup();

    await passToken(user);

    expect(verifyToken).toHaveBeenCalledWith('the-token');
    expect(await screen.findByTestId('setup-error')).toHaveTextContent(
      'The setup token is not valid.',
    );
    expect(screen.queryByLabelText('Full name')).toBeNull();
  });

  it('validates the administrator form before calling the API', async () => {
    const props = renderSetup();
    const user = userEvent.setup();
    await passToken(user);

    await user.type(await screen.findByLabelText('Full name'), 'Root');
    await user.type(screen.getByLabelText('Username'), 'r');
    await user.type(screen.getByLabelText('Email'), 'nope');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'different');
    await user.type(screen.getByLabelText('Admin panel address (optional)'), 'ftp://x');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(props.complete).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a valid email address.')).toBeVisible();
    expect(screen.getByText('The password must be at least 12 characters.')).toBeVisible();
    expect(screen.getByText('The passwords do not match.')).toBeVisible();
    expect(screen.getByText('Enter a full http or https address.')).toBeVisible();
  });

  it('creates the administrator, sends the origin only and then wipes the secrets', async () => {
    const props = renderSetup();
    const user = userEvent.setup();
    await passToken(user);
    await fillAdmin(user);
    await user.type(
      screen.getByLabelText('Admin panel address (optional)'),
      'https://admin.example.com/ignored/path',
    );
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByTestId('setup-done')).toHaveTextContent('Setup complete');
    expect(props.complete).toHaveBeenCalledWith({
      token: 'the-token',
      displayName: 'Root Admin',
      username: 'root.admin',
      email: 'root@example.com',
      password: PASSWORD,
      adminUrl: 'https://admin.example.com',
    });
    expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute(
      'href',
      'https://admin.example.com',
    );
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it('lists password policy violations from the server', async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: false,
      error: 'password_policy',
      violations: ['common_password'],
    });
    renderSetup({ complete });
    const user = userEvent.setup();
    await passToken(user);
    await fillAdmin(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByTestId('setup-error')).toHaveTextContent(
      'This password is common; choose another one.',
    );
    expect(screen.getByLabelText('New password')).toBeVisible();
  });

  it('returns to the token step when the server rejects the token', async () => {
    const complete = vi.fn().mockResolvedValue({ ok: false, error: 'invalid_token' });
    renderSetup({ complete });
    const user = userEvent.setup();
    await passToken(user);
    await fillAdmin(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByLabelText('Setup token')).toBeVisible();
    expect(screen.getByTestId('setup-error')).toHaveTextContent('The setup token is not valid.');
  });

  it('closes the wizard when another request already finished the install', async () => {
    const complete = vi.fn().mockResolvedValue({ ok: false, error: 'closed' });
    renderSetup({ complete });
    const user = userEvent.setup();
    await passToken(user);
    await fillAdmin(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByTestId('setup-installed')).toBeVisible();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('renders in Persian with the new password hint', async () => {
    render(
      <IdpnRoot locale="fa-IR" dir="rtl">
        <SetupPage
          locale="fa-IR"
          loadStatus={vi.fn().mockResolvedValue('open')}
          verifyToken={vi.fn()}
          complete={vi.fn()}
        />
      </IdpnRoot>,
    );
    expect(await screen.findByLabelText('توکن نصب')).toBeVisible();
  });
});
