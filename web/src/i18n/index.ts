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
