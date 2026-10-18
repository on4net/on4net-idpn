import * as React from 'react';

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

export interface MfeUser {
  id: string;
  name: string;
  email: string;
}

const DEFAULT_USERS: readonly MfeUser[] = [
  { id: 'u1', name: 'سارا محمدی', email: 'sara@example.com' },
  { id: 'u2', name: 'علی رضایی', email: 'ali@example.com' },
];

export interface UserManagementProps {
  initialUsers?: readonly MfeUser[];
}

/**
 * The `user-management` micro-frontend module. It is exported both through Module
 * Federation (React host) and through the Web Component wrapper.
 */
export function UserManagement({ initialUsers = DEFAULT_USERS }: UserManagementProps) {
  const portalContainer = usePortalContainer();
  const [users, setUsers] = React.useState<readonly MfeUser[]>(initialUsers);
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const addUser = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() === '' || email.trim() === '') {
      return;
    }
    setUsers((current) => [...current, { id: `u${current.length + 1}`, name, email }]);
    setName('');
    setEmail('');
    setDialogOpen(false);
  };

  return (
    <section className="w-full max-w-xl rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-foreground">مدیریت کاربران</h2>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>افزودن کاربر</Button>
          </DialogTrigger>
          <DialogContent container={portalContainer} aria-describedby="add-user-description">
            <DialogTitle>کاربر جدید</DialogTitle>
            <DialogDescription id="add-user-description" className="mt-2">
              کاربر به همین اپ اضافه می‌شود.
            </DialogDescription>
            <form className="mt-4 grid gap-3" onSubmit={addUser}>
              <div className="grid gap-1">
                <Label htmlFor="mfe-user-name">نام</Label>
                <Input
                  id="mfe-user-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="mfe-user-email">ایمیل</Label>
                <Input
                  id="mfe-user-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <DialogClose asChild>
                  <Button variant="outline" type="button">
                    انصراف
                  </Button>
                </DialogClose>
                <Button type="submit">ذخیره</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <ul className="divide-y divide-border" aria-label="فهرست کاربران">
        {users.map((user) => (
          <li key={user.id} className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm font-medium text-foreground">{user.name}</span>
            <span className="text-sm text-muted-foreground" dir="ltr">
              {user.email}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default UserManagement;
