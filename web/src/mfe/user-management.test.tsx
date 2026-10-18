import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { IdpnRoot } from '@/app/idpn-root';
import { UserManagement } from './user-management';

function renderModule() {
  return render(
    <IdpnRoot locale="fa-IR" dir="rtl">
      <UserManagement />
    </IdpnRoot>,
  );
}

describe('UserManagement MFE module', () => {
  it('lists the seeded users', () => {
    renderModule();

    expect(screen.getByRole('heading', { name: 'مدیریت کاربران' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'فهرست کاربران' })).toHaveTextContent('سارا محمدی');
    expect(screen.getByRole('list', { name: 'فهرست کاربران' })).toHaveTextContent('علی رضایی');
  });

  it('adds a user through the dialog and closes it', async () => {
    const user = userEvent.setup();
    renderModule();

    await user.click(screen.getByRole('button', { name: 'افزودن کاربر' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('کاربر جدید');

    await user.type(screen.getByLabelText('نام'), 'مریم احمدی');
    await user.type(screen.getByLabelText('ایمیل'), 'maryam@example.com');
    await user.click(screen.getByRole('button', { name: 'ذخیره' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'فهرست کاربران' })).toHaveTextContent('مریم احمدی');
  });

  it('ignores an empty submission', async () => {
    const user = userEvent.setup();
    renderModule();

    await user.click(screen.getByRole('button', { name: 'افزودن کاربر' }));
    await user.click(await screen.findByRole('button', { name: 'ذخیره' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    const list = await screen.findByRole('list', { name: 'فهرست کاربران' });
    expect(list.children).toHaveLength(2);
  });
});
