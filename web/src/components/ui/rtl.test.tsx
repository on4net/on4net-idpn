import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { IdpnRoot } from '@/app/idpn-root';

import { Alert, AlertDescription, AlertTitle } from './alert';
import { Button } from './button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

/**
 * Physical utilities that break when the writing direction flips. `px-*`, `py-*`, `border`,
 * `rounded-lg` and `gap-*` are symmetric and intentionally allowed.
 */
const PHYSICAL_UTILITY = [
  /^text-(?:left|right)$/,
  /^(?:m|p)[lr]-/,
  /^(?:left|right)-/,
  /^border-[lr](?:-|$)/,
  /^rounded-[lr](?:-|$)/,
  /^translate-x-/,
  /^space-x-/,
  /^slide-(?:in|out)-from-(?:left|right)$/,
];

function physicalUtilities(root: ParentNode): string[] {
  const found = new Set<string>();
  for (const element of root.querySelectorAll<HTMLElement>('[class]')) {
    for (const token of element.classList) {
      if (PHYSICAL_UTILITY.some((pattern) => pattern.test(token))) {
        found.add(token);
      }
    }
  }
  return [...found].sort();
}

function Surface({ dir }: { dir: 'rtl' | 'ltr' }) {
  return (
    <IdpnRoot locale={dir === 'rtl' ? 'fa-IR' : 'en-US'} dir={dir}>
      <Alert>
        <AlertTitle>title</AlertTitle>
        <AlertDescription>message</AlertDescription>
      </Alert>

      <Input aria-label="email" dir="ltr" defaultValue="sara@example.com" />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>email</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <bdi dir="ltr">sara@example.com</bdi>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Select>
        <SelectTrigger aria-label="role">
          <SelectValue placeholder="choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">admin</SelectItem>
        </SelectContent>
      </Select>

      <Dialog>
        <DialogTrigger asChild>
          <Button>open dialog</Button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>dialog title</DialogTitle>
        </DialogContent>
      </Dialog>
    </IdpnRoot>
  );
}

function rootDir(): string | null {
  return screen.getByTestId('idpn-root').getAttribute('dir');
}

/** Drops color/theme classes so the snapshot fails only on layout regressions. */
function layoutClasses(className: string): string[] {
  return className
    .split(/\s+/)
    .filter((token) =>
      /^(?:text-start|text-end|text-(?:left|right)|p[slrexy]?-|m[slre]-|start-|end-|left-|right-)/.test(
        token,
      ),
    )
    .sort();
}

describe.each([
  { locale: 'fa-IR', dir: 'rtl' as const, expected: 'rtl' as const },
  { locale: 'en-US', dir: 'ltr' as const, expected: 'ltr' as const },
])('logical layout in $locale', ({ locale, dir, expected }) => {
  it('keeps every consumed primitive free of physical utilities', () => {
    render(<Surface dir={dir} />);

    expect(physicalUtilities(document.body)).toEqual([]);
  });

  it('applies direction to the root, table, dialog and select portals', async () => {
    const user = userEvent.setup();
    render(<Surface dir={dir} />);

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('dir', expected);
    expect(root).toHaveAttribute('lang', locale);

    const head = screen.getByRole('columnheader', { name: 'email' });
    expect(head).toHaveClass('text-start');
    expect(screen.getByRole('cell', { name: 'sara@example.com' })).toHaveClass('text-start');

    const email = screen.getByLabelText('email');
    expect(email).toHaveAttribute('dir', 'ltr');
    expect(email).toHaveClass('text-start');

    // The alert reserves logical inline padding when an icon is present.
    expect(screen.getByRole('alert')).toHaveClass('[&>svg~*]:ps-7');

    await user.click(screen.getByRole('combobox', { name: 'role' }));
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveAttribute('dir', expected);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'open dialog' }));
    const dialog = await screen.findByRole('dialog', { name: 'dialog title' });
    expect(dialog.closest('[dir]')).toHaveAttribute('dir', expected);

    const portalRoot = screen.getByTestId('idpn-portal-root');
    expect(portalRoot).toContainElement(dialog);
    expect(document.body.querySelector(':scope > [role="dialog"]')).toBeNull();
  });

  it('keeps list, dialog and table alignment structurally stable', async () => {
    const user = userEvent.setup();
    render(<Surface dir={dir} />);

    const head = screen.getByRole('columnheader', { name: 'email' });
    const cell = screen.getByRole('cell', { name: 'sara@example.com' });
    const alert = screen.getByRole('alert');

    await user.click(screen.getByRole('combobox', { name: 'role' }));
    const listbox = await screen.findByRole('listbox');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'open dialog' }));
    const dialog = await screen.findByRole('dialog', { name: 'dialog title' });

    expect({
      root: rootDir(),
      tableHead: layoutClasses(head.className),
      tableCell: layoutClasses(cell.className),
      alert: layoutClasses(alert.className),
      dialog: dialog.closest('[dir]')?.getAttribute('dir'),
      listbox: listbox.getAttribute('dir'),
      portalsInsideRoot: screen.getByTestId('idpn-portal-root').contains(dialog),
    }).toMatchSnapshot();
  });
});
