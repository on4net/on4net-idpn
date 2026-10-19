import * as React from 'react';

import { IdpnRoot, usePortalContainer } from '@/app/idpn-root';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  MfeApiError,
  createMfeApiClient,
  type MfeApiClient,
  type MfeMember,
  type MfeRole,
  type MemberStatus,
} from './api-client';

export interface UserManagementEvent {
  type: 'auth:error';
  code: string;
}

export interface UserManagementProps {
  /** Public client id of the host application; the API scope is limited to it. */
  clientId: string;
  /** BFF base URL; defaults to same-origin. */
  apiBaseUrl?: string;
  /** SPA mode only: returns the in-memory access token. Never persist it. */
  getAccessToken?: () => string | null;
  locale?: string;
  dir?: 'rtl' | 'ltr';
  pageSize?: number;
  /** Receives non-sensitive module events; never contains a token. */
  onEvent?: (event: UserManagementEvent) => void;
  /** Test seam; production hosts use the configured client. */
  apiClient?: MfeApiClient;
}

const STATUS_LABEL: Record<MemberStatus, string> = {
  invited: 'دعوت‌شده',
  active: 'فعال',
  suspended: 'معلق',
};

const STATUS_VARIANT: Record<MemberStatus, 'default' | 'outline' | 'destructive'> = {
  invited: 'outline',
  active: 'default',
  suspended: 'destructive',
};

const STATUS_OPTIONS: readonly { value: 'all' | MemberStatus; label: string }[] = [
  { value: 'all', label: 'همه وضعیت‌ها' },
  { value: 'invited', label: STATUS_LABEL.invited },
  { value: 'active', label: STATUS_LABEL.active },
  { value: 'suspended', label: STATUS_LABEL.suspended },
];

const describeError = (error: unknown): string => {
  if (error instanceof MfeApiError) {
    if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
      return 'دسترسی به مدیریت اعضای این اپ مجاز نیست.';
    }
    if (error.kind === 'network') {
      return 'ارتباط با سرور برقرار نشد.';
    }
    return error.detail ?? 'درخواست انجام نشد.';
  }
  return 'خطای غیرمنتظره رخ داد.';
};

const isAbort = (error: unknown): boolean =>
  typeof DOMException !== 'undefined' &&
  error instanceof DOMException &&
  error.name === 'AbortError';

const toggleKey = (keys: string[], key: string): string[] =>
  keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];

/**
 * `user-management` micro-frontend module (docs/micro-frontend.md 8).
 *
 * Renders the members of exactly one app. The client id is configuration, never user
 * input; every request goes to `/api/v1/clients/{clientId}/…` through the host's BFF (or an
 * in-memory token in SPA mode). Events never carry a token.
 */
export function UserManagement({
  clientId,
  apiBaseUrl,
  getAccessToken,
  locale = 'fa-IR',
  dir = 'rtl',
  pageSize = 10,
  onEvent,
  apiClient,
}: UserManagementProps) {
  const portalContainer = usePortalContainer();
  const api = React.useMemo(
    () =>
      apiClient ??
      createMfeApiClient({
        clientId,
        ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }),
        ...(getAccessToken === undefined ? {} : { getAccessToken }),
      }),
    [apiClient, clientId, apiBaseUrl, getAccessToken],
  );

  const [members, setMembers] = React.useState<MfeMember[]>([]);
  const [total, setTotal] = React.useState(0);
  const [roles, setRoles] = React.useState<MfeRole[]>([]);
  const [page, setPage] = React.useState(1);
  const [searchInput, setSearchInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<'all' | MemberStatus>('all');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const report = React.useCallback(
    (caught: unknown): string => {
      if (caught instanceof MfeApiError) {
        onEvent?.({ type: 'auth:error', code: caught.kind });
      }
      return describeError(caught);
    },
    [onEvent],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    api
      .listMembers(
        {
          page,
          limit: pageSize,
          ...(query === '' ? {} : { q: query }),
          ...(status === 'all' ? {} : { status }),
        },
        { signal: controller.signal },
      )
      .then((result) => {
        if (!active) {
          return;
        }
        setMembers(result.items);
        setTotal(result.total);
      })
      .catch((caught: unknown) => {
        if (!active || isAbort(caught)) {
          return;
        }
        setError(report(caught));
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [api, page, pageSize, query, status, reloadKey, report]);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    api
      .listRoles({ signal: controller.signal })
      .then((items) => {
        if (active) {
          setRoles(items);
        }
      })
      .catch(() => {
        // Roles are optional for the list view; the dialogs explain the gap.
        if (active) {
          setRoles([]);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api]);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteName, setInviteName] = React.useState('');
  const [inviteRoleKeys, setInviteRoleKeys] = React.useState<string[]>([]);
  const [inviteAttributes, setInviteAttributes] = React.useState('');
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);

  const [roleTarget, setRoleTarget] = React.useState<MfeMember | null>(null);
  const [roleDraft, setRoleDraft] = React.useState<string[]>([]);
  const [roleError, setRoleError] = React.useState<string | null>(null);
  const [savingRoles, setSavingRoles] = React.useState(false);

  const resetInvite = () => {
    setInviteEmail('');
    setInviteName('');
    setInviteRoleKeys([]);
    setInviteAttributes('');
    setInviteError(null);
  };

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(searchInput.trim());
  };

  const submitInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteError(null);

    let attributes: Record<string, unknown> = {};
    if (inviteAttributes.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(inviteAttributes);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        attributes = parsed as Record<string, unknown>;
      } catch {
        setInviteError('ویژگی‌ها باید یک شیء JSON معتبر باشند.');
        return;
      }
    }

    setInviting(true);
    try {
      await api.inviteMember({
        email: inviteEmail.trim(),
        ...(inviteName.trim() === '' ? {} : { displayName: inviteName.trim() }),
        roleKeys: inviteRoleKeys,
        attributes,
      });
      setInviteOpen(false);
      resetInvite();
      setPage(1);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setInviteError(report(caught));
    } finally {
      setInviting(false);
    }
  };

  const openRoleDialog = (member: MfeMember) => {
    setRoleTarget(member);
    setRoleDraft(member.roleKeys);
    setRoleError(null);
  };

  const saveRoles = async () => {
    if (roleTarget === null) {
      return;
    }
    setSavingRoles(true);
    setRoleError(null);
    try {
      await api.replaceRoles(roleTarget.userId, roleDraft);
      setRoleTarget(null);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setRoleError(report(caught));
    } finally {
      setSavingRoles(false);
    }
  };

  const changeStatus = async (member: MfeMember, next: MemberStatus) => {
    setError(null);
    try {
      await api.updateMember(member.userId, { status: next });
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(report(caught));
    }
  };

  const rolePicker = (selected: string[], onToggle: (key: string) => void) =>
    roles.length === 0 ? (
      <p className="text-sm text-muted-foreground">نقشی برای این اپ تعریف نشده است.</p>
    ) : (
      <div role="group" aria-label="نقش‌های این اپ" className="flex flex-wrap gap-2">
        {roles.map((role) => (
          <Button
            key={role.key}
            type="button"
            size="sm"
            variant={selected.includes(role.key) ? 'default' : 'outline'}
            aria-pressed={selected.includes(role.key)}
            onClick={() => onToggle(role.key)}
          >
            {role.name}
          </Button>
        ))}
      </div>
    );

  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);

  return (
    <section
      className="w-full max-w-4xl rounded-lg border border-border bg-card p-6"
      aria-busy={loading}
      dir={dir}
      lang={locale}
      data-client-id={clientId}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">مدیریت کاربران</h2>
          <p className="text-sm text-muted-foreground" dir="ltr">
            {clientId}
          </p>
        </div>

        <Dialog
          open={inviteOpen}
          onOpenChange={(open) => {
            setInviteOpen(open);
            if (!open) {
              resetInvite();
            }
          }}
        >
          <DialogTrigger asChild>
            <Button>دعوت کاربر</Button>
          </DialogTrigger>
          <DialogContent container={portalContainer} aria-describedby="invite-member-description">
            <DialogTitle>دعوت عضو جدید</DialogTitle>
            <DialogDescription id="invite-member-description" className="mt-2">
              کاربر فقط به همین اپ اضافه می‌شود.
            </DialogDescription>
            <form className="mt-4 grid gap-3" onSubmit={submitInvite} noValidate>
              <div className="grid gap-1">
                <Label htmlFor="mfe-invite-email">ایمیل</Label>
                <Input
                  id="mfe-invite-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="mfe-invite-name">نام نمایشی (اختیاری)</Label>
                <Input
                  id="mfe-invite-name"
                  value={inviteName}
                  onChange={(event) => setInviteName(event.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label>نقش‌ها</Label>
                {rolePicker(inviteRoleKeys, (key) =>
                  setInviteRoleKeys((keys) => toggleKey(keys, key)),
                )}
              </div>
              <div className="grid gap-1">
                <Label htmlFor="mfe-invite-attributes">ویژگی‌ها (JSON، اختیاری)</Label>
                <textarea
                  id="mfe-invite-attributes"
                  className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={inviteAttributes}
                  onChange={(event) => setInviteAttributes(event.target.value)}
                  aria-describedby="mfe-invite-attributes-help"
                />
                <p id="mfe-invite-attributes-help" className="text-xs text-muted-foreground">
                  ویژگی‌ها باید با طرح عضویت این اپ هم‌خوان باشند.
                </p>
              </div>
              {inviteError !== null && (
                <Alert variant="destructive">
                  <AlertTitle>دعوت انجام نشد</AlertTitle>
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <DialogClose asChild>
                  <Button variant="outline" type="button">
                    انصراف
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={inviting}>
                  {inviting ? 'در حال ارسال…' : 'دعوت'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <form className="mb-4 flex flex-wrap items-end gap-3" role="search" onSubmit={submitSearch}>
        <div className="grid gap-1">
          <Label htmlFor="mfe-member-search">جست‌وجو</Label>
          <Input
            id="mfe-member-search"
            placeholder="نام یا ایمیل"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="mfe-member-status">وضعیت</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as 'all' | MemberStatus);
              setPage(1);
            }}
          >
            <SelectTrigger id="mfe-member-status" aria-label="وضعیت عضویت">
              <SelectValue />
            </SelectTrigger>
            <SelectContent container={portalContainer}>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          جست‌وجو
        </Button>
      </form>

      {error !== null && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>خطا در دریافت اعضا</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              تلاش دوباره
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div aria-live="polite" className="mb-2 min-h-6 text-sm text-muted-foreground">
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <Spinner /> در حال بارگذاری…
          </span>
        ) : (
          `${total} عضو`
        )}
      </div>

      {!loading && error === null && members.length === 0 && (
        <p className="py-8 text-center text-muted-foreground">کاربری یافت نشد.</p>
      )}

      {!loading && members.length > 0 && error === null && (
        <Table>
          <TableCaption>اعضای اپ {clientId}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>نام</TableHead>
              <TableHead>ایمیل</TableHead>
              <TableHead>وضعیت</TableHead>
              <TableHead>نقش‌ها</TableHead>
              <TableHead>عملیات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.userId}>
                <TableCell className="font-medium text-foreground">{member.displayName}</TableCell>
                <TableCell dir="ltr" className="text-muted-foreground">
                  {member.email}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[member.status]}>
                    {STATUS_LABEL[member.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {member.roleKeys.length === 0 ? '—' : member.roleKeys.join('، ')}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {member.status === 'active' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void changeStatus(member, 'suspended')}
                      >
                        تعلیق
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void changeStatus(member, 'active')}
                      >
                        فعال‌سازی
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => openRoleDialog(member)}
                    >
                      نقش‌ها
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          صفحه {page} از {pageCount}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={loading || page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            قبلی
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading || page >= pageCount}
            onClick={() => setPage((value) => value + 1)}
          >
            بعدی
          </Button>
        </div>
      </div>

      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRoleTarget(null);
            setRoleError(null);
          }
        }}
      >
        <DialogContent container={portalContainer} aria-describedby="member-roles-description">
          <DialogTitle>نقش‌های {roleTarget?.displayName ?? ''}</DialogTitle>
          <DialogDescription id="member-roles-description" className="mt-2">
            فقط نقش‌های همین اپ قابل تخصیص هستند.
          </DialogDescription>
          <div className="mt-4 grid gap-3">
            {rolePicker(roleDraft, (key) => setRoleDraft((keys) => toggleKey(keys, key)))}
            {roleError !== null && (
              <Alert variant="destructive">
                <AlertTitle>ذخیره نقش‌ها انجام نشد</AlertTitle>
                <AlertDescription>{roleError}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="outline" type="button">
                  انصراف
                </Button>
              </DialogClose>
              <Button type="button" disabled={savingRoles} onClick={() => void saveRoles()}>
                {savingRoles ? 'در حال ذخیره…' : 'ذخیره نقش‌ها'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export type UserManagementRootProps = UserManagementProps;

/**
 * Self-contained entry point for hosts: owns `.idpn-root`, direction and portal container so
 * it works identically through Module Federation and the Web Component.
 */
export function UserManagementRoot({
  locale = 'fa-IR',
  dir = 'rtl',
  ...props
}: UserManagementRootProps) {
  return (
    <IdpnRoot locale={locale} dir={dir}>
      <UserManagement {...props} locale={locale} dir={dir} />
    </IdpnRoot>
  );
}

export default UserManagementRoot;
