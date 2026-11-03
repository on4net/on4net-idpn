import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HostedLoginPage, type HostedLoginPageProps } from './hosted-login';
import {
  LoginContextMethodNotice,
  LoginContextPanel,
  LoginContextSelector,
} from './login-context-selector';
import { MfaForm, type MfaErrorCode } from './mfa-form';
import type { LoginContextSummary } from './login-context';
import { formatCurrency, formatDate, formatNumber } from '@/i18n';

/**
 * Consolidated localization regression suite for the Hosted UI surfaces
 * (docs/localization.md 3, 7, 8 and 13, docs/testing.md LOC-001..012).
 *
 * The per-component tests cover behaviour; this suite is the matrix that proves every
 * localized surface - login, MFA, context selector and panel - renders exact Persian and
 * English strings, derives `dir` from the locale, keeps the document in sync, and never
 * shows a raw message key. Fixtures are fixed; nothing depends on the host machine locale.
 */

type FetchConfig = NonNullable<HostedLoginPageProps['fetchConfig']>;
type TestConfig = NonNullable<Awaited<ReturnType<FetchConfig>>>;

const configFor = (defaultLocale: 'fa-IR' | 'en-US'): TestConfig => ({
  locale: defaultLocale,
  locales: {
    default: defaultLocale,
    supported: ['fa-IR', 'en-US'],
    dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
  },
  translationsUrl: '/api/v1/clients/app-a/translations/bundle',
  theme: {},
});

const baseBundle = async ({ locale }: { locale: 'fa-IR' | 'en-US' }) => ({
  locale,
  messages: {},
});

async function waitForForm(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId('hosted-login-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('data-bundle-state', 'ready');
  });
}

interface HostedCase {
  name: string;
  config: TestConfig;
  search: string;
  acceptLanguage: string;
  locale: 'fa-IR' | 'en-US';
  dir: 'rtl' | 'ltr';
  heading: string;
  font: string;
  languageLabel: string;
}

const HOSTED_CASES: readonly HostedCase[] = [
  {
    name: 'ui_locales wins over Accept-Language',
    config: configFor('fa-IR'),
    search: '?client_id=app-a&ui_locales=en-US',
    acceptLanguage: 'fa-IR',
    locale: 'en-US',
    dir: 'ltr',
    heading: 'Sign in',
    font: 'Inter',
    languageLabel: 'Language',
  },
  {
    name: 'explicit Persian ui_locales wins over an English browser',
    config: configFor('en-US'),
    search: '?client_id=app-a&ui_locales=fa-IR',
    acceptLanguage: 'en-US',
    locale: 'fa-IR',
    dir: 'rtl',
    heading: 'ورود به حساب',
    font: 'Vazirmatn',
    languageLabel: 'زبان',
  },
  {
    name: 'unsupported ui_locales falls through to Accept-Language',
    config: configFor('fa-IR'),
    search: '?client_id=app-a&ui_locales=de-DE',
    acceptLanguage: 'en-US',
    locale: 'en-US',
    dir: 'ltr',
    heading: 'Sign in',
    font: 'Inter',
    languageLabel: 'Language',
  },
  {
    name: 'malformed ui_locales never renders and falls to the client default',
    config: configFor('fa-IR'),
    search: '?client_id=app-a&ui_locales=%3Cscript%3E',
    acceptLanguage: 'fr-FR',
    locale: 'fa-IR',
    dir: 'rtl',
    heading: 'ورود به حساب',
    font: 'Vazirmatn',
    languageLabel: 'زبان',
  },
  {
    name: 'Accept-Language quality selects English',
    config: configFor('fa-IR'),
    search: '?client_id=app-a',
    acceptLanguage: 'fa-IR;q=0.1, en-US;q=0.9',
    locale: 'en-US',
    dir: 'ltr',
    heading: 'Sign in',
    font: 'Inter',
    languageLabel: 'Language',
  },
  {
    name: 'a zero-quality preference is ignored and the client default wins',
    config: configFor('fa-IR'),
    search: '?client_id=app-a',
    acceptLanguage: 'en-US;q=0',
    locale: 'fa-IR',
    dir: 'rtl',
    heading: 'ورود به حساب',
    font: 'Vazirmatn',
    languageLabel: 'زبان',
  },
  {
    name: 'an unsupported browser locale falls back to the configured client default',
    config: configFor('en-US'),
    search: '?client_id=app-a',
    acceptLanguage: 'de-DE, fr-FR;q=0.5',
    locale: 'en-US',
    dir: 'ltr',
    heading: 'Sign in',
    font: 'Inter',
    languageLabel: 'Language',
  },
  {
    name: 'a language-only ui_locales tag maps to the enabled variant',
    config: configFor('en-US'),
    search: '?client_id=app-a&ui_locales=fa',
    acceptLanguage: 'en-US',
    locale: 'fa-IR',
    dir: 'rtl',
    heading: 'ورود به حساب',
    font: 'Vazirmatn',
    languageLabel: 'زبان',
  },
];

describe.each(HOSTED_CASES)('Hosted login locale — $name', (testCase) => {
  it(`renders ${testCase.locale} (${testCase.dir}) with translated copy`, async () => {
    render(
      <HostedLoginPage
        search={testCase.search}
        acceptLanguage={testCase.acceptLanguage}
        fetchConfig={vi.fn().mockResolvedValue(testCase.config)}
        fetchBundle={vi.fn(baseBundle)}
      />,
    );
    await waitForForm();

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('lang', testCase.locale);
    expect(root).toHaveAttribute('dir', testCase.dir);
    expect(root).toHaveAttribute('data-config-state', 'ready');
    expect(root).toHaveAttribute('data-bundle-state', 'ready');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain(`'${testCase.font}'`);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('lang', testCase.locale);
      expect(document.documentElement).toHaveAttribute('dir', testCase.dir);
    });

    expect(screen.getByRole('heading', { level: 1, name: testCase.heading })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('dir', testCase.dir);
    expect(screen.getByRole('combobox', { name: testCase.languageLabel })).toBeInTheDocument();
    expect(screen.queryAllByText(/^[a-z][\w]*(\.[\w]+)+$/)).toHaveLength(0);
  });
});

describe('Hosted login bidi isolation', () => {
  it('keeps an email-like login_hint in an auto-direction field', async () => {
    render(
      <HostedLoginPage
        search="?client_id=app-a&login_hint=sara%40example.com"
        acceptLanguage="fa-IR"
        fetchConfig={vi.fn().mockResolvedValue(configFor('fa-IR'))}
        fetchBundle={vi.fn(baseBundle)}
      />,
    );
    await waitForForm();

    const identifier = screen.getByLabelText('ایمیل یا نام کاربری');
    expect(identifier).toHaveValue('sara@example.com');
    expect(identifier).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
  });
});

describe('web formatting wrapper', () => {
  const INSTANT = new Date('2026-10-19T20:30:00.000Z');

  it('formats numbers with Persian and Latin digits exactly', () => {
    expect(formatNumber('fa-IR', 1234567.89)).toBe('۱٬۲۳۴٬۵۶۷٫۸۹');
    expect(formatNumber('en-US', 1234567.89)).toBe('1,234,567.89');
  });

  it('formats Persian and Gregorian dates deterministically in UTC', () => {
    expect(
      formatDate('fa-IR-u-ca-persian', INSTANT, {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }),
    ).toBe('۲۷ مهر ۱۴۰۵');
    expect(formatDate('en-US', INSTANT, { dateStyle: 'medium', timeZone: 'UTC' })).toBe(
      'Oct 19, 2026',
    );
  });

  it('formats currency with the locale separator and symbol', () => {
    expect(formatCurrency('fa-IR', 1250000, 'IRR')).toBe('\u200eریال\u00a0۱٬۲۵۰٬۰۰۰');
    expect(formatCurrency('en-US', 1250000, 'IRR')).toBe('IRR\u00a01,250,000');
  });
});

interface MfaCopy {
  dir: 'rtl' | 'ltr';
  title: string;
  subtitle: string;
  codeLabel: string;
  submit: string;
  recovery: string;
  back: string;
}

const MFA_COPY: Readonly<Record<'fa-IR' | 'en-US', MfaCopy>> = {
  'fa-IR': {
    dir: 'rtl',
    title: 'ورود دومرحله‌ای',
    subtitle: 'برای ادامه، کد تأیید برنامه احراز هویت را وارد کنید.',
    codeLabel: 'کد ۶ رقمی',
    submit: 'تأیید و ورود',
    recovery: 'استفاده از کد بازیابی',
    back: 'بازگشت به ورود',
  },
  'en-US': {
    dir: 'ltr',
    title: 'Two-step verification',
    subtitle: 'Enter the code from your authenticator app to continue.',
    codeLabel: '6-digit code',
    submit: 'Verify and sign in',
    recovery: 'Use a recovery code',
    back: 'Back to sign in',
  },
};

const LOCALES = ['fa-IR', 'en-US'] as const;

describe.each(LOCALES)('MfaForm localization — %s', (locale) => {
  const copy = MFA_COPY[locale];

  it('renders the step in the locale direction with an LTR code field', () => {
    const { container } = render(
      <MfaForm
        locale={locale}
        dir={copy.dir}
        submitting={false}
        errorCode={null}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole('main')).toHaveAttribute('dir', copy.dir);
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.subtitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.submit })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.recovery })).toBeInTheDocument();

    const code = screen.getByLabelText(copy.codeLabel);
    expect(code).toHaveAttribute('dir', 'ltr');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('maxlength', '6');
    expect(container.textContent).not.toMatch(/\bmfa\.[A-Za-z]/);
  });

  it('validates an empty code with the localized message', async () => {
    const user = userEvent.setup();
    render(
      <MfaForm
        locale={locale}
        dir={copy.dir}
        submitting={false}
        errorCode={null}
        onSubmit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      locale === 'fa-IR' ? 'کد تأیید را وارد کنید.' : 'Enter the verification code.',
    );
    expect(screen.getByLabelText(copy.codeLabel)).toHaveAttribute('aria-invalid', 'true');
  });

  it('validates the digit format and the recovery format', async () => {
    const user = userEvent.setup();
    render(
      <MfaForm
        locale={locale}
        dir={copy.dir}
        submitting={false}
        errorCode={null}
        onSubmit={vi.fn()}
      />,
    );

    const code = screen.getByLabelText(copy.codeLabel);
    await user.type(code, '123');
    await user.click(screen.getByRole('button', { name: copy.submit }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      locale === 'fa-IR' ? 'کد باید ۶ رقم باشد.' : 'The code must be 6 digits.',
    );

    await user.click(screen.getByRole('button', { name: copy.recovery }));
    expect(
      screen.getByText(
        locale === 'fa-IR'
          ? 'کد بازیابی ۱۰ کاراکتری را با خط تیره وارد کنید.'
          : 'Enter the 10-character recovery code including the dash.',
      ),
    ).toBeInTheDocument();

    const recoveryLabel = locale === 'fa-IR' ? 'کد بازیابی' : 'Recovery code';
    const recovery = screen.getByLabelText(recoveryLabel);
    expect(recovery).toHaveAttribute('maxlength', '11');
    await user.type(recovery, 'ABC');
    await user.click(screen.getByRole('button', { name: copy.submit }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      locale === 'fa-IR'
        ? 'کد بازیابی باید ۱۰ کاراکتر باشد.'
        : 'The recovery code must be 10 characters.',
    );
  });

  it('shows the localized submitting state without losing the direction', () => {
    render(
      <MfaForm locale={locale} dir={copy.dir} submitting errorCode={null} onSubmit={vi.fn()} />,
    );

    expect(
      screen.getByText(locale === 'fa-IR' ? 'در حال بررسی…' : 'Verifying…'),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('dir', copy.dir);
  });

  it('offers a localized passkey action and back control', async () => {
    const user = userEvent.setup();
    const onPasskey = vi.fn();
    const onBack = vi.fn();
    render(
      <MfaForm
        locale={locale}
        dir={copy.dir}
        submitting={false}
        errorCode={null}
        passkeyAvailable
        onPasskey={onPasskey}
        onBack={onBack}
        onSubmit={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole('button', {
        name: locale === 'fa-IR' ? 'ورود با Passkey' : 'Sign in with a passkey',
      }),
    );
    expect(onPasskey).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: copy.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

const MFA_ERROR_MESSAGES: readonly [MfaErrorCode, { 'fa-IR': string; 'en-US': string }][] = [
  ['invalid_code', { 'fa-IR': 'کد واردشده معتبر نیست.', 'en-US': 'That code is not valid.' }],
  [
    'expired',
    {
      'fa-IR': 'زمان این ورود به پایان رسیده است. دوباره وارد شوید.',
      'en-US': 'This sign-in attempt expired. Please sign in again.',
    },
  ],
  [
    'rate_limited',
    {
      'fa-IR': 'تلاش‌های ناموفق بیش از حد بود. دوباره وارد شوید.',
      'en-US': 'Too many failed attempts. Please sign in again.',
    },
  ],
  [
    'network',
    {
      'fa-IR': 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
      'en-US': 'Could not reach the server. Please try again.',
    },
  ],
  [
    'passkey_failed',
    {
      'fa-IR': 'تأیید Passkey انجام نشد. دوباره تلاش کنید.',
      'en-US': 'The passkey could not be verified. Please try again.',
    },
  ],
  [
    'passkey_unsupported',
    {
      'fa-IR': 'این مرورگر از Passkey پشتیبانی نمی‌کند.',
      'en-US': 'This browser does not support passkeys.',
    },
  ],
];

describe.each(MFA_ERROR_MESSAGES)('MFA error localization — %s', (errorCode, messages) => {
  it.each(LOCALES)('renders the %s message', (locale) => {
    render(
      <MfaForm
        locale={locale}
        dir={MFA_COPY[locale].dir}
        submitting={false}
        errorCode={errorCode}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText(messages[locale])).toBeInTheDocument();
    expect(screen.getByText(MFA_COPY[locale].title)).toBeInTheDocument();
  });
});

const CONTEXTS: readonly LoginContextSummary[] = [
  {
    key: 'customer-admin',
    name: 'Customer admin',
    description: 'Manages users and billing',
    methods: ['password', 'google'],
    mfaPolicy: 'required_all',
    registrationPolicy: 'invite_only',
    branding: { title: 'Customer admin console' },
  },
  {
    key: 'customer-team',
    name: 'Customer team',
    description: 'Day-to-day operations',
    methods: ['password', 'facebook'],
    mfaPolicy: 'optional',
    registrationPolicy: 'self_service',
  },
];

const CONTEXT_COPY = {
  'fa-IR': {
    dir: 'rtl',
    selectorTitle: 'انتخاب روش ورود',
    selectorHint: 'هر گزینه دسترسی و سیاست امنیتی خودش را دارد.',
    defaultBadge: 'پیش‌فرض',
    unavailable: 'این روش ورود در دسترس نیست؛ یکی از گزینه‌های دیگر را انتخاب کنید.',
    panelLabel: 'مشخصات روش ورود',
    mfaRequiredAll: 'برای این روش ورود، تأیید دومرحله‌ای الزامی است.',
    inviteOnly: 'ساخت حساب فقط با دعوت مدیر امکان‌پذیر است.',
    methodNotice:
      'این روش ورود با رمز عبور انجام نمی‌شود؛ از گزینه‌های موجود همین صفحه استفاده کنید.',
  },
  'en-US': {
    dir: 'ltr',
    selectorTitle: 'Choose how to sign in',
    selectorHint: 'Each option has its own access and security policy.',
    defaultBadge: 'Default',
    unavailable: 'This sign-in option is not available. Choose another one.',
    panelLabel: 'Sign-in option details',
    mfaRequiredAll: 'This sign-in option requires a second factor.',
    inviteOnly: 'Accounts are created by invitation only.',
    methodNotice: 'This option does not use a password. Use one of the available sign-in methods.',
  },
} as const;

describe.each(LOCALES)('Login context localization — %s', (locale) => {
  const copy = CONTEXT_COPY[locale];

  it('renders the selector with translated guidance and options in the locale direction', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LoginContextSelector
        locale={locale}
        dir={copy.dir}
        contexts={CONTEXTS}
        value="customer-admin"
        defaultKey="customer-admin"
        onChange={onChange}
      />,
    );

    const selector = screen.getByTestId('login-context-selector');
    expect(selector).toHaveAttribute('dir', copy.dir);
    expect(screen.getByRole('group', { name: copy.selectorTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.selectorHint)).toBeInTheDocument();
    expect(screen.getByText(copy.defaultBadge)).toBeInTheDocument();
    expect(screen.getByText('Customer admin')).toBeInTheDocument();
    expect(screen.getByText('Manages users and billing')).toBeInTheDocument();
    expect(screen.getByText('Customer team')).toBeInTheDocument();
    expect(selector.textContent).not.toMatch(/login\.context\.[A-Za-z]/);

    await user.click(screen.getByTestId('login-context-option-customer-team'));
    expect(onChange).toHaveBeenCalledWith('customer-team');
  });

  it('explains an unavailable requested context in the locale language', () => {
    render(
      <LoginContextSelector
        locale={locale}
        dir={copy.dir}
        contexts={CONTEXTS}
        value="customer-admin"
        invalidRequested
        onChange={vi.fn()}
      />,
    );

    const selector = screen.getByTestId('login-context-selector');
    expect(within(selector).getByRole('alert')).toHaveTextContent(copy.unavailable);
  });

  it('renders the context panel and its policy lines in the locale language', () => {
    render(
      <LoginContextPanel
        locale={locale}
        dir={copy.dir}
        context={CONTEXTS[0] as LoginContextSummary}
      />,
    );

    const panel = screen.getByTestId('login-context-panel');
    expect(panel).toHaveAttribute('dir', copy.dir);
    expect(screen.getByLabelText(copy.panelLabel)).toBe(panel);
    expect(screen.getByText('Customer admin console')).toBeInTheDocument();
    expect(screen.getByText(copy.mfaRequiredAll)).toBeInTheDocument();
    expect(screen.getByText(copy.inviteOnly)).toBeInTheDocument();
  });

  it('renders the method notice when the context does not allow passwords', () => {
    render(<LoginContextMethodNotice locale={locale} dir={copy.dir} />);

    const notice = screen.getByTestId('login-context-method-notice');
    expect(notice).toHaveAttribute('dir', copy.dir);
    expect(within(notice).getByText(copy.methodNotice)).toBeInTheDocument();
    expect(notice.textContent).not.toMatch(/login\.context\.[A-Za-z]/);
  });
});
