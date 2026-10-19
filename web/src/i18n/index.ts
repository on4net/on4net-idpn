export type Locale = 'fa-IR' | 'en-US';

export const SUPPORTED_LOCALES: Locale[] = ['fa-IR', 'en-US'];

type Messages = Record<string, string>;

const fa: Messages = {
  'login.title': 'ورود به حساب',
  'login.subtitle': 'برای ادامه، اطلاعات حساب خود را وارد کنید.',
  'login.identifier': 'ایمیل یا نام کاربری',
  'login.password': 'رمز عبور',
  'login.submit': 'ورود',
  'login.submitting': 'در حال ورود…',
  'login.errorRequired': 'ایمیل یا نام کاربری را وارد کنید.',
  'login.errorPasswordRequired': 'رمز عبور را وارد کنید.',
  'login.errorInvalid': 'نام کاربری یا رمز عبور نادرست است.',
  'login.errorNetwork': 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
  'login.forgot': 'رمز عبور را فراموش کرده‌اید؟',
  'login.errorSummary': 'ورود انجام نشد',
  'login.showPassword': 'نمایش رمز عبور',
  'login.hidePassword': 'پنهان‌کردن رمز عبور',
  'common.loading': 'در حال بارگذاری',
  'admin.title': 'مدیریت کاربران',
  'admin.create': 'کاربر جدید',
  'admin.search': 'جست‌وجو',
  'admin.searchPlaceholder': 'نام، ایمیل یا نام کاربری',
  'admin.searchAction': 'جست‌وجو',
  'admin.caption': '{total} کاربر',
  'admin.columnUser': 'کاربر',
  'admin.columnEmail': 'ایمیل',
  'admin.columnStatus': 'وضعیت',
  'admin.columnActions': 'عملیات',
  'admin.status.active': 'فعال',
  'admin.status.pending': 'در انتظار',
  'admin.status.locked': 'قفل‌شده',
  'admin.status.disabled': 'غیرفعال',
  'admin.empty': 'کاربری یافت نشد.',
  'admin.previous': 'قبلی',
  'admin.next': 'بعدی',
  'admin.pageOf': 'صفحه {page} از {lastPage}',
  'admin.username': 'نام کاربری',
  'admin.email': 'ایمیل',
  'admin.displayName': 'نام نمایشی',
  'admin.save': 'ذخیره',
  'admin.resetPassword': 'بازنشانی رمز',
  'admin.enable': 'فعال‌سازی',
  'admin.disable': 'غیرفعال‌سازی',
  'admin.created': 'کاربر {email} ساخته شد.',
  'admin.enabled': 'کاربر {email} فعال شد.',
  'admin.disabled': 'کاربر {email} غیرفعال و نشست‌هایش باطل شد.',
  'admin.passwordReset': 'رمز {email} بازنشانی و نشست‌هایش باطل شد.',
  'admin.tempPasswordTitle': 'رمز موقت (فقط یک بار نمایش داده می‌شود)',
  'admin.signedOutTitle': 'ورود ادمین لازم است',
  'admin.signedOutBody': 'برای مدیریت کاربران، از طریق پنل ادمین وارد شوید.',
  'admin.errorTitle': 'عملیات انجام نشد',
  'admin.errorForbidden': 'دسترسی لازم برای این عملیات را ندارید.',
  'admin.errorUnauthorized': 'نشست شما منقضی شده است. دوباره وارد شوید.',
  'admin.errorNetwork': 'ارتباط با سرور برقرار نشد.',
  'admin.errorGeneric': 'خطای غیرمنتظره رخ داد.',
  'admin.tabs.users': 'کاربران',
  'admin.tabs.audit': 'ممیزی',
  'admin.audit.title': 'رویدادهای ممیزی',
  'admin.audit.filters': 'فیلترهای ممیزی',
  'admin.audit.from': 'از تاریخ',
  'admin.audit.to': 'تا تاریخ',
  'admin.audit.action': 'عملیات',
  'admin.audit.actorId': 'شناسه کاربر',
  'admin.audit.clientId': 'شناسه کلاینت',
  'admin.audit.targetType': 'نوع هدف',
  'admin.audit.result': 'نتیجه',
  'admin.audit.result.all': 'همه',
  'admin.audit.result.success': 'موفق',
  'admin.audit.result.failure': 'ناموفق',
  'admin.audit.apply': 'اعمال فیلتر',
  'admin.audit.reset': 'پاک‌کردن',
  'admin.audit.format': 'قالب خروجی',
  'admin.audit.export': 'دریافت خروجی',
  'admin.audit.exporting': 'در حال تهیه خروجی…',
  'admin.audit.exported': 'فایل خروجی آماده شد.',
  'admin.audit.caption': '{total} رویداد',
  'admin.audit.columnTime': 'زمان',
  'admin.audit.columnAction': 'عملیات',
  'admin.audit.columnActor': 'کاربر',
  'admin.audit.columnTarget': 'هدف',
  'admin.audit.columnClient': 'کلاینت',
  'admin.audit.columnResult': 'نتیجه',
  'admin.audit.empty': 'رویدادی یافت نشد.',
  'admin.audit.systemActor': 'سیستم',
  'admin.audit.none': '—',
};

const en: Messages = {
  'login.title': 'Sign in',
  'login.subtitle': 'Enter your account details to continue.',
  'login.identifier': 'Email or username',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.errorRequired': 'Enter your email or username.',
  'login.errorPasswordRequired': 'Enter your password.',
  'login.errorInvalid': 'Incorrect username or password.',
  'login.errorNetwork': 'Could not reach the server. Please try again.',
  'login.forgot': 'Forgot your password?',
  'login.errorSummary': 'Sign-in failed',
  'login.showPassword': 'Show password',
  'login.hidePassword': 'Hide password',
  'common.loading': 'Loading',
  'admin.title': 'User management',
  'admin.create': 'New user',
  'admin.search': 'Search',
  'admin.searchPlaceholder': 'Name, email or username',
  'admin.searchAction': 'Search',
  'admin.caption': '{total} users',
  'admin.columnUser': 'User',
  'admin.columnEmail': 'Email',
  'admin.columnStatus': 'Status',
  'admin.columnActions': 'Actions',
  'admin.status.active': 'Active',
  'admin.status.pending': 'Pending',
  'admin.status.locked': 'Locked',
  'admin.status.disabled': 'Disabled',
  'admin.empty': 'No users found.',
  'admin.previous': 'Previous',
  'admin.next': 'Next',
  'admin.pageOf': 'Page {page} of {lastPage}',
  'admin.username': 'Username',
  'admin.email': 'Email',
  'admin.displayName': 'Display name',
  'admin.save': 'Save',
  'admin.resetPassword': 'Reset password',
  'admin.enable': 'Enable',
  'admin.disable': 'Disable',
  'admin.created': 'User {email} was created.',
  'admin.enabled': 'User {email} is active again.',
  'admin.disabled': 'User {email} was disabled and their sessions were revoked.',
  'admin.passwordReset': 'The password for {email} was reset and sessions were revoked.',
  'admin.tempPasswordTitle': 'Temporary password (shown once)',
  'admin.signedOutTitle': 'Admin sign-in required',
  'admin.signedOutBody': 'Sign in through the admin panel to manage users.',
  'admin.errorTitle': 'Action failed',
  'admin.errorForbidden': 'You do not have the permission for this action.',
  'admin.errorUnauthorized': 'Your session has expired. Sign in again.',
  'admin.errorNetwork': 'Could not reach the server.',
  'admin.errorGeneric': 'An unexpected error occurred.',
  'admin.tabs.users': 'Users',
  'admin.tabs.audit': 'Audit',
  'admin.audit.title': 'Audit events',
  'admin.audit.filters': 'Audit filters',
  'admin.audit.from': 'From',
  'admin.audit.to': 'To',
  'admin.audit.action': 'Action',
  'admin.audit.actorId': 'Actor ID',
  'admin.audit.clientId': 'Client ID',
  'admin.audit.targetType': 'Target type',
  'admin.audit.result': 'Result',
  'admin.audit.result.all': 'All',
  'admin.audit.result.success': 'Success',
  'admin.audit.result.failure': 'Failure',
  'admin.audit.apply': 'Apply filters',
  'admin.audit.reset': 'Reset',
  'admin.audit.format': 'Export format',
  'admin.audit.export': 'Export',
  'admin.audit.exporting': 'Exporting…',
  'admin.audit.exported': 'The export file is ready.',
  'admin.audit.caption': '{total} events',
  'admin.audit.columnTime': 'Time',
  'admin.audit.columnAction': 'Action',
  'admin.audit.columnActor': 'Actor',
  'admin.audit.columnTarget': 'Target',
  'admin.audit.columnClient': 'Client',
  'admin.audit.columnResult': 'Result',
  'admin.audit.empty': 'No audit events found.',
  'admin.audit.systemActor': 'System',
  'admin.audit.none': '—',
};

export const MESSAGES: Record<Locale, Messages> = { 'fa-IR': fa, 'en-US': en };

/**
 * Resolves the UI locale: the first supported entry of `ui_locales` wins, otherwise the
 * client default, otherwise Persian (docs/auth-flows.md 2.6).
 */
export function resolveLocale(
  uiLocales: string | undefined,
  supported: readonly string[] = SUPPORTED_LOCALES,
  fallback: string = 'fa-IR',
): Locale {
  const requested = (uiLocales ?? '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const supportedLower = new Map(supported.map((locale) => [locale.toLowerCase(), locale]));

  for (const candidate of requested) {
    const exact = supportedLower.get(candidate.toLowerCase());
    if (exact !== undefined) {
      return toLocale(exact);
    }
    const language = candidate.split('-')[0]?.toLowerCase();
    const prefixMatch = [...supportedLower.entries()].find(
      ([key]) => key.split('-')[0] === language,
    );
    if (prefixMatch !== undefined) {
      return toLocale(prefixMatch[1]);
    }
  }

  const fallbackMatch = supportedLower.get(fallback.toLowerCase());
  return toLocale(fallbackMatch ?? 'fa-IR');
}

export function directionOf(locale: string): 'rtl' | 'ltr' {
  return locale.toLowerCase().startsWith('fa') || locale.toLowerCase().startsWith('ar')
    ? 'rtl'
    : 'ltr';
}

/** Looks up a message, falling back to the key so a missing translation is visible in tests. */
export function translate(
  locale: Locale,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const template = MESSAGES[locale][key] ?? MESSAGES['fa-IR'][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(values[name] ?? `{${name}}`),
  );
}

function toLocale(value: string): Locale {
  return value.toLowerCase().startsWith('en') ? 'en-US' : 'fa-IR';
}
