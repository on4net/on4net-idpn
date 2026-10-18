import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { usePortalContainer } from '@/app/idpn-root';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const loginSchema = z.object({
  identifier: z.string().min(1, 'ایمیل یا نام کاربری را وارد کنید').email('ایمیل معتبر نیست'),
  password: z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد'),
  loginContext: z.enum(['customer-admin', 'customer-team']),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const portalContainer = usePortalContainer();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting, isSubmitSuccessful },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { identifier: '', password: '', loginContext: 'customer-admin' },
  });

  const loginContext = watch('loginContext');

  const onSubmit = async (_values: LoginValues) => {
    await Promise.resolve();
  };

  return (
    <main className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-xl font-semibold text-foreground">ورود به حساب</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        برای ادامه، اطلاعات حساب خود را وارد کنید.
      </p>

      <form className="grid gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="grid gap-2">
          <Label htmlFor="identifier">ایمیل</Label>
          <Input
            id="identifier"
            type="email"
            autoComplete="username"
            aria-invalid={errors.identifier ? true : undefined}
            aria-describedby={errors.identifier ? 'identifier-error' : undefined}
            {...register('identifier')}
          />
          {errors.identifier ? (
            <p id="identifier-error" role="alert" className="text-xs text-destructive">
              {errors.identifier.message}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password">رمز عبور</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...register('password')}
          />
          {errors.password ? (
            <p id="password-error" role="alert" className="text-xs text-destructive">
              {errors.password.message}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="login-context">نوع ورود</Label>
          <Select
            value={loginContext}
            onValueChange={(value) =>
              setValue('loginContext', value as LoginValues['loginContext'], {
                shouldValidate: true,
              })
            }
          >
            <SelectTrigger id="login-context" aria-label="نوع ورود">
              <SelectValue />
            </SelectTrigger>
            <SelectContent container={portalContainer}>
              <SelectItem value="customer-admin">مدیر مشتری</SelectItem>
              <SelectItem value="customer-team">تیم مشتری</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'در حال ورود…' : 'ورود'}
        </Button>

        {isSubmitSuccessful ? (
          <p role="status" className="text-sm text-muted-foreground">
            درخواست ورود ثبت شد.
          </p>
        ) : null}
      </form>

      <div className="mt-4 text-sm">
        <Dialog>
          <DialogTrigger className="text-primary underline-offset-4 hover:underline">
            رمز عبور را فراموش کرده‌اید؟
          </DialogTrigger>
          <DialogContent container={portalContainer} aria-describedby="reset-description">
            <DialogTitle>بازیابی رمز عبور</DialogTitle>
            <DialogDescription id="reset-description" className="mt-2">
              لینک بازیابی به ایمیل ثبت‌شده ارسال می‌شود.
            </DialogDescription>
            <div className="mt-6 flex justify-end">
              <DialogClose asChild>
                <Button variant="outline">بستن</Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}
