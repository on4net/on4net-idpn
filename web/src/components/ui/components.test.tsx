import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import { Alert, AlertDescription, AlertTitle } from './alert';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from './form';
import { Input } from './input';
import { ScrollArea } from './scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Spinner } from './spinner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Button', () => {
  it('renders as a child element with asChild and forwards variants', () => {
    render(
      <Button asChild variant="outline" size="sm">
        <a href="/forgot-password">بازیابی</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'بازیابی' });
    expect(link).toHaveAttribute('href', '/forgot-password');
    expect(link.className).toContain('border');
  });
});

describe('Card', () => {
  it('renders its slots', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>عنوان کارت</CardTitle>
          <CardDescription>توضیح کارت</CardDescription>
        </CardHeader>
        <CardContent>محتوا</CardContent>
      </Card>,
    );

    expect(screen.getByText('عنوان کارت')).toBeInTheDocument();
    expect(screen.getByText('توضیح کارت')).toBeInTheDocument();
    expect(screen.getByText('محتوا')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('applies variant classes and forwards props', () => {
    render(
      <>
        <Badge>پیش‌فرض</Badge>
        <Badge variant="outline" data-testid="outline">
          حاشیه
        </Badge>
      </>,
    );

    expect(screen.getByText('پیش‌فرض')).toHaveClass('bg-primary');
    expect(screen.getByTestId('outline')).toHaveClass('border-border');
  });
});

describe('Alert', () => {
  it('exposes an alert role and variant styles', () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>خطا</AlertTitle>
        <AlertDescription>مشکلی رخ داد</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('text-destructive');
    expect(alert).toHaveTextContent('خطا');
    expect(alert).toHaveTextContent('مشکلی رخ داد');
  });
});

describe('Spinner', () => {
  it('announces the localized loading state to screen readers', () => {
    render(<Spinner label="در حال بارگذاری" />);

    expect(screen.getByRole('status')).toHaveTextContent('در حال بارگذاری');
  });
});

describe('ScrollArea', () => {
  it('renders its children inside the viewport', () => {
    render(
      <ScrollArea className="h-24" data-testid="scroll">
        <div>محتوای اسکرول</div>
      </ScrollArea>,
    );

    expect(screen.getByText('محتوای اسکرول')).toBeVisible();
  });
});

describe('Tabs', () => {
  it('switches panels with the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="account">
        <TabsList aria-label="بخش‌ها">
          <TabsTrigger value="account">حساب</TabsTrigger>
          <TabsTrigger value="security">امنیت</TabsTrigger>
        </TabsList>
        <TabsContent value="account">محتوای حساب</TabsContent>
        <TabsContent value="security">محتوای امنیت</TabsContent>
      </Tabs>,
    );

    expect(screen.getByText('محتوای حساب')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'امنیت' }));
    expect(screen.getByText('محتوای امنیت')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'امنیت' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Table', () => {
  it('renders a caption, header and body rows', () => {
    render(
      <Table>
        <TableCaption>فهرست کاربران</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>نام</TableHead>
            <TableHead>ایمیل</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>سارا</TableCell>
            <TableCell>sara@example.com</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'نام' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'sara@example.com' })).toBeInTheDocument();
  });
});

describe('Select', () => {
  it('opens the listbox and selects an item with the keyboard', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger aria-label="نوع ورود">
          <SelectValue placeholder="انتخاب" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">مدیر</SelectItem>
          <SelectItem value="team">تیم</SelectItem>
        </SelectContent>
      </Select>,
    );

    await user.click(screen.getByRole('combobox', { name: 'نوع ورود' }));
    const option = await screen.findByRole('option', { name: 'تیم' });
    await user.click(option);

    expect(onValueChange).toHaveBeenCalledWith('team');
  });
});

describe('Form', () => {
  function EmailForm({ onSubmit }: { onSubmit: (email: string) => void }) {
    const form = useForm<{ email: string }>({ defaultValues: { email: '' } });

    return (
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit((values) => onSubmit(values.email))}
          aria-label="فرم ایمیل"
        >
          <FormField
            control={form.control}
            name="email"
            rules={{ required: 'ایمیل الزامی است' }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>ایمیل</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <button type="submit">ارسال</button>
        </form>
      </Form>
    );
  }

  it('links the label, control and validation message', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EmailForm onSubmit={onSubmit} />);

    const input = screen.getByLabelText('ایمیل');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));

    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent('ایمیل الزامی است');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(message.id);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(input, 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));

    expect(onSubmit).toHaveBeenCalledWith('user@example.com');
  });
});
