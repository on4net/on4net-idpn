import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { LoginForm } from '@/app/login-form';

import { expectNoBlockingAxeViolations } from '@/test/axe';

import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog';
import { Input } from './input';
import { Label } from './label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

/**
 * Component-level axe checks (docs/testing.md 8: axe-core for form/Dialog/Table).
 *
 * The browser-level suite in `e2e/a11y/surfaces.spec.ts` is the acceptance gate because
 * only a real browser can evaluate contrast and portalled overlays; these checks keep the
 * semantic contract next to the components so a regression fails the fast unit suite too.
 */
describe('shadcn/ui accessibility', () => {
  it('login form exposes labelled fields and error associations', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LoginForm
        locale="fa-IR"
        dir="rtl"
        submitting={false}
        errorCode={null}
        onSubmit={() => {}}
      />,
    );

    await expectNoBlockingAxeViolations(container);

    await user.click(screen.getByRole('button', { name: 'ورود' }));
    const identifier = screen.getByLabelText('ایمیل یا نام کاربری');
    expect(identifier).toHaveAttribute('aria-invalid', 'true');
    expect(identifier).toHaveAttribute('aria-describedby', 'identifier-error');

    await expectNoBlockingAxeViolations(container);
  });

  it('open dialog has an accessible name and a description', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button">باز کردن</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>ویرایش کاربر</DialogTitle>
          <DialogDescription>تغییر نام نمایشی کاربر.</DialogDescription>
          <Label htmlFor="dialog-name">نام نمایشی</Label>
          <Input id="dialog-name" name="displayName" />
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', { name: 'باز کردن' }));
    const dialog = await screen.findByRole('dialog', { name: 'ویرایش کاربر' });
    expect(dialog).toBeInTheDocument();

    await expectNoBlockingAxeViolations();
  });

  it('open select exposes listbox and option semantics', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger aria-label="وضعیت عضویت">
          <SelectValue placeholder="انتخاب" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">فعال</SelectItem>
          <SelectItem value="invited">دعوت‌شده</SelectItem>
        </SelectContent>
      </Select>,
    );

    await user.click(screen.getByRole('combobox', { name: 'وضعیت عضویت' }));
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    await expectNoBlockingAxeViolations();
  });

  it('table has a caption and header cells', async () => {
    const { container } = render(
      <Table>
        <TableCaption>اعضای اپ app-a</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>نام</TableHead>
            <TableHead>ایمیل</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>نگار کریمی</TableCell>
            <TableCell>negar@example.com</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    await expectNoBlockingAxeViolations(container);
  });
});
