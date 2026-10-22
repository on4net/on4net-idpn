import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { IdpnRoot } from '@/app/idpn-root';

import { Dialog, DialogContent, DialogTitle } from './dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('scoped Radix portals', () => {
  it('renders a dialog inside the root portal host, never on document.body', async () => {
    render(
      <IdpnRoot locale="fa-IR" dir="rtl">
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>عنوان گفتگو</DialogTitle>
          </DialogContent>
        </Dialog>
      </IdpnRoot>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'عنوان گفتگو' });
    const portalRoot = screen.getByTestId('idpn-portal-root');
    expect(portalRoot).toContainElement(dialog);
    expect(document.body.querySelector(':scope > [role="dialog"]')).toBeNull();
  });

  it('keeps a select opened from inside a dialog in the same scoped portal host', async () => {
    const user = userEvent.setup();
    render(
      <IdpnRoot locale="fa-IR" dir="rtl">
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>نقش‌ها</DialogTitle>
            <Select>
              <SelectTrigger aria-label="نقش">
                <SelectValue placeholder="انتخاب نقش" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">مدیر</SelectItem>
              </SelectContent>
            </Select>
          </DialogContent>
        </Dialog>
      </IdpnRoot>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'نقش‌ها' });
    await user.click(screen.getByRole('combobox', { name: 'نقش' }));
    const listbox = await screen.findByRole('listbox');

    const portalRoot = screen.getByTestId('idpn-portal-root');
    expect(portalRoot).toContainElement(dialog);
    expect(portalRoot).toContainElement(listbox);
    expect(document.body.querySelector(':scope > [role="listbox"]')).toBeNull();

    await waitFor(() => expect(screen.getByRole('option', { name: 'مدیر' })).toBeVisible());
  });
});
