# SDK میکرو-فرانت‌اند و راهنمای اتصال

> هدف: یک بسته مصرف‌شدنی (`@idpn/mfe-sdk`) و دستورالعمل کامل برای اتصال ماژول‌های
> `account` و `user-management` به اپ‌های React (Module Federation) و غیر-React
> (Web Component). قرارداد Config/Event در [micro-frontend.md](./micro-frontend.md)
> تعریف شده و این سند نحوهٔ استفادهٔ عملی از آن است.

- نسخه SDK: `0.1.0`
- نسخه قرارداد Config/Event: `1` (`MFE_SCHEMA_VERSION`)
- ماژول‌ها: `user-management` و `account` (ماژول `admin` و `hosted-auth` داخل اپ Mount نمی‌شوند.)

## 1. نصب

```bash
pnpm add @idpn/mfe-sdk@^0.1.0
```

`@idpn/mfe-sdk` هیچ وابستگی Runtime ندارد و React را Bundle نمی‌کند. برای میزبان‌های
غیر-React، بستهٔ Web Component را جداگانه و با نسخهٔ پین‌شده بارگذاری کنید:

```html
<script type="module" src="https://cdn.example.com/idpn-mfe/1.4.0/web-component.js"></script>
```

ترتیب بارگذاری مهم است: اسکریپت Bundle باید قبل از اولین `mountIdpnModule` اجرا شود تا
Custom Elementها ثبت شوند. اگر اسکریپت بعداً بارگذاری شود، المان ساخته‌شده به‌صورت خودکار
Upgrade می‌شود ولی تا آن زمان چیزی رندر نمی‌شود.

## 2. انتخاب حالت اتصال

| حالت | مناسب برای | ورودی | احراز هویت |
|---|---|---|---|
| Module Federation | اپ‌های React 19 | `remoteEntry.js` با نسخهٔ پین‌شده | BFF (کوکی) یا SPA (Getter در حافظه) |
| Web Component | Vue، Angular، HTML، Legacy | `web-component.js` | BFF (کوکی) یا SPA فقط برای `user-management` |

### 2.1 Module Federation (React)

Remote با نام `idpnMfe` دو ماژول را Export می‌کند: `./UserManagement` و `./Account`.
React و ReactDOM به‌صورت Singleton به اشتراک گذاشته می‌شوند.

```ts
// webpack / rspack / module-federation/vite
remotes: {
  idpnMfe: 'idpnMfe@https://cdn.example.com/idpn-mfe/1.4.0/remoteEntry.js',
},
shared: {
  react: { singleton: true, requiredVersion: '^19.0.0' },
  'react-dom': { singleton: true, requiredVersion: '^19.0.0' },
},
```

```tsx
const Account = React.lazy(() => import('idpnMfe/Account'));
const UserManagement = React.lazy(() => import('idpnMfe/UserManagement'));
```

نسخهٔ Major را در URL پین کنید. فایل `mf-manifest.json` هر Build (تولیدشده توسط
`pnpm --filter @idpn/web run build:mfe`) برای کشف نسخهٔ سازگار در CDN منتشر می‌شود.

### 2.2 Web Component (غیر-React)

Bundle سه المان را ثبت می‌کند:

| المان | ماژول پیش‌فرض | توضیح |
|---|---|---|
| `<on4net-idpn-user-management>` | `user-management` | المان قدیمی؛ بدون تغییر سازگار است. |
| `<on4net-idpn-account>` | `account` | ماژول حساب کاربری. |
| `<on4net-idpn-mfe module="…">` | ندارد | انتخاب صریح ماژول با `module`. |

```html
<on4net-idpn-account
  client-id="app-a"
  api-base="/auth"
  locale="fa-IR"
  dir="rtl"
></on4net-idpn-account>
```

`module` هم Attribute است و هم Property؛ مقدار Property بر Attribute اولویت دارد.
تغییر `module` در زمان اجرا محتوای همان Shadow Root را دوباره رندر می‌کند.

## 3. استفاده از SDK

### 3.1 `mountIdpnModule(container, config)`

المان ماژول را داخل `container` می‌سازد و یک Handle برمی‌گرداند. اگر همان ماژول قبلاً در
همان Container Mount شده باشد، همان المان Update می‌شود (مناسب StrictMode، HMR و ورود
دوباره به Route). Mount کردن ماژول دیگر، المان قبلی را جایگزین می‌کند.

```ts
import { mountIdpnModule, type IdpnMfeConfig } from '@idpn/mfe-sdk';

const config: IdpnMfeConfig = {
  clientId: 'app-a', // از تنظیمات اپ؛ هرگز از ورودی کاربر
  module: 'account',
  mode: 'bff',
  apiBaseUrl: '/auth',
  locale: 'fa-IR',
  dir: 'rtl',
  theme: { brand: '#0057b8', radius: '0.75rem' },
  onEvent: (event) => {
    if (event.type === 'auth:logout') window.location.assign('/login');
    if (event.type === 'auth:error') console.warn(`[idpn] ${event.code}`);
  },
};

const mounted = mountIdpnModule(document.querySelector('#idpn-account')!, config);

// تغییر Locale یا Theme بدون Mount دوباره
mounted.update({ ...config, locale: 'en-US', dir: 'ltr' });

// در زمان Unmount شدن Route
mounted.unmount();
```

قواعد:

- `mountIdpnModule` فقط Attributeهای غیرحساس `client-id`، `api-base`، `locale` و `dir` را
  می‌نویسد و نشانگر `data-idpn-mfe` را برای شناسایی المان خودش اضافه می‌کند.
- `getAccessToken`، `onEvent` و `theme` فقط Property جاوااسکریپتی در حافظه هستند و در DOM،
  Attribute، رویداد یا Storage نوشته نمی‌شوند.
- `unmount()` ابتدا Getter توکن، Event Handler و Theme را پاک می‌کند و سپس المان را حذف
  می‌کند؛ المان‌های دیگر میزبان دست‌نخورده می‌مانند.
- `unmountIdpnModule(handle)` معادل `handle.unmount()` است.
- در محیط بدون DOM (SSR) فراخوانی عمداً خطا می‌دهد؛ Mount را در `useEffect`/`onMounted`
  انجام دهید.
- Configuration نامعتبر (از جمله وجود `accessToken`، `refreshToken`، `idToken`، `token`
  یا `clientSecret`) با `TypeError` رد می‌شود و DOM تغییر نمی‌کند.

### 3.2 مثال کامل React (Module Federation)

```tsx
import * as React from 'react';
import { Suspense } from 'react';
import type { IdpnEvent, IdpnMfeConfig } from '@idpn/mfe-sdk';

const Account = React.lazy(() => import('idpnMfe/Account'));
const UserManagement = React.lazy(() => import('idpnMfe/UserManagement'));

interface IdpnModulePageProps {
  config: IdpnMfeConfig;
}

class IdpnErrorBoundary extends React.Component<
  { fallback: string; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    return this.state.failed ? <p role="alert">{this.props.fallback}</p> : this.props.children;
  }
}

export function IdpnAccountPage({ config }: IdpnModulePageProps) {
  const handleEvent = React.useCallback(
    (event: IdpnEvent) => {
      switch (event.type) {
        case 'auth:logout':
          window.location.assign(config.loginUrl ?? '/login');
          break;
        case 'navigation:request':
          window.location.assign(event.to);
          break;
        case 'auth:error':
          console.warn(`[idpn] ${event.code}`);
          break;
        default:
          break;
      }
    },
    [config.loginUrl],
  );

  const shared = {
    clientId: config.clientId,
    apiBaseUrl: config.apiBaseUrl,
    locale: config.locale,
    dir: config.dir,
    theme: config.theme,
    onEvent: handleEvent,
  };

  return (
    <IdpnErrorBoundary fallback={`حساب کاربری در دسترس نیست: ${config.loginUrl ?? '/login'}`}>
      <Suspense fallback={<p aria-busy="true">در حال بارگذاری…</p>}>
        {config.module === 'account' ? (
          <Account {...shared} />
        ) : (
          <UserManagement
            {...shared}
            pageSize={10}
            {...(config.mode === 'spa' && config.getAccessToken
              ? { getAccessToken: config.getAccessToken }
              : {})}
          />
        )}
      </Suspense>
    </IdpnErrorBoundary>
  );
}
```

اگر Remote بارگذاری نشد، Error Boundary کاربر را به صفحهٔ Hosted روی دامنهٔ IdP هدایت
می‌کند (`config.loginUrl`). فرم رمز یا دکمهٔ سوشال هرگز داخل اپ ساخته نمی‌شود.

### 3.3 مثال کامل Vanilla / HTML

```html
<!doctype html>
<html lang="fa" dir="rtl">
  <body>
    <div id="idpn-account"></div>

    <script type="module" src="https://cdn.example.com/idpn-mfe/1.4.0/web-component.js"></script>
    <script type="module">
      import { mountIdpnModule } from '/vendor/idpn-mfe-sdk/index.js';

      const config = {
        clientId: 'app-a',
        module: 'account',
        mode: 'bff',
        apiBaseUrl: '/auth',
        locale: 'fa-IR',
        dir: 'rtl',
        onEvent(event) {
          if (event.type === 'auth:logout') window.location.assign('/login');
        },
      };

      const mounted = mountIdpnModule(document.querySelector('#idpn-account'), config);
      window.addEventListener('beforeunload', () => mounted.unmount());
    </script>
  </body>
</html>
```

در اپ واقعی، SDK را با Bundler نصب کنید و از Import bare استفاده کنید؛ مسیر `/vendor/...`
فقط نمونه است.

### 3.4 مثال Vue 3

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { mountIdpnModule, type IdpnMfeConfig, type IdpnMountedModule } from '@idpn/mfe-sdk';

const props = defineProps<{ config: IdpnMfeConfig }>();
const host = ref<HTMLElement | null>(null);
let mounted: IdpnMountedModule | null = null;

onMounted(() => {
  mounted = mountIdpnModule(host.value!, props.config);
});

watch(
  () => props.config,
  (next) => mounted?.update(next),
  { deep: true },
);

onBeforeUnmount(() => {
  mounted?.unmount();
  mounted = null;
});
</script>

<template>
  <div ref="host" :dir="props.config.dir ?? 'rtl'" :lang="props.config.locale ?? 'fa-IR'" />
</template>
```

## 4. قرارداد تنظیمات

| فیلد | الزامی | نوع | کاربرد |
|---|---|---|---|
| `clientId` | بله | `string` | شناسهٔ عمومی کلاینت؛ از تنظیمات اپ، نه ورودی کاربر. |
| `module` | بله | `'user-management' \| 'account'` | ماژول فعال. |
| `mode` | بله | `'bff' \| 'spa'` | حالت احراز هویت. |
| `apiBaseUrl` | بله | `string` | پیشوند `/auth` در BFF یا Origin API در SPA. |
| `loginUrl` | خیر | `string` | آدرس Hosted Auth برای Redirect سطح‌بالا. |
| `locale` | خیر | `string` | Locale فعال (BCP 47). |
| `dir` | خیر | `'rtl' \| 'ltr'` | جهت؛ در صورت نبود از Locale استخراج می‌شود. |
| `theme` | خیر | `Record<string, string>` | توکن‌ها به‌صورت `--<name>` و `--idpn-<name>` روی ریشه. |
| `locales` | خیر | `{ default, supported[], dir{} }` | فهرست Localeهای همان اپ. |
| `loginContext` | خیر | `string` | Context فعال همان Route؛ فقط نمایشی. |
| `basename` | خیر | `string` | پایهٔ Router داخلی MFE. |
| `features` | خیر | `{ selfServiceRegistration?, userManagement?, mfa? }` | فعال‌سازی قابلیت‌های اختیاری. |
| `getAccessToken` | فقط SPA | `() => string \| null` | Getter توکن در حافظه؛ در BFF نادیده گرفته و پاک می‌شود. |
| `onEvent` | خیر | `(event: IdpnEvent) => void` | دریافت رویدادهای غیرحساس. |

در Web Component، SDK فقط `clientId`، `apiBaseUrl`، `locale`، `dir`، `theme`،
`getAccessToken` و `onEvent` را منتقل می‌کند. `loginUrl`، `locales`، `loginContext`،
`basename` و `features` بخشی از قرارداد میزبان Module Federation هستند.

Attributeهای المان:

| Attribute | معادل Config | نامعتبر |
|---|---|---|
| `client-id` | `clientId` | پیام `client-id لازم است.` |
| `api-base` | `apiBaseUrl` | Same-origin |
| `locale` | `locale` | `fa-IR` |
| `dir` | `dir` | استخراج از Locale |
| `module` | `module` | فقط در المان عمومی الزامی است |
| `page-size` | — | فقط `user-management`، پیش‌فرض `10` |

## 5. قرارداد رویدادها

```ts
type IdpnEvent =
  | { type: 'auth:login'; user: IdpnPublicUser; loginContext: string }
  | { type: 'auth:logout'; reason: 'local' | 'global' | 'expired' }
  | { type: 'auth:error'; code: string }
  | { type: 'profile:updated'; user: IdpnPublicUser }
  | { type: 'locale:changed'; locale: string; dir: 'rtl' | 'ltr' }
  | { type: 'context:changed'; loginContext: string }
  | { type: 'navigation:request'; to: string };
```

- **هیچ رویدادی توکن، Refresh Token یا Secret ندارد.** میزبان باید رویدادها را فقط برای
  به‌روزرسانی UI استفاده کند؛ مجوزها همیشه در سرور بررسی می‌شوند.
- رویدادها از طریق Property `onEvent` به میزبان می‌رسند:

```ts
const element = document.querySelector('on4net-idpn-account')!;
(element as HTMLElement & { onEvent?: (event: IdpnEvent) => void }).onEvent = (event) => {
  if (event.type === 'locale:changed') document.documentElement.dir = event.dir;
};
```

- `navigation:request` یعنی MFE درخواست عبور به مسیر Hosted را دارد؛ تصمیم نهایی با
  میزبان است و باید فقط به Origin مجاز هدایت کند.
- `auth:logout` با `reason=global` یعنی نشست مرکزی باطل شده است؛ همهٔ اپ‌ها باید UI خود
  را پاک کنند.

## 6. امنیت BFF در برابر SPA

### 6.1 BFF (پیش‌فرض و توصیه‌شده)

- توکن‌ها فقط در Session سرور BFF نگه‌داری می‌شوند؛ مرورگر فقط کوکی
  `HttpOnly; Secure; SameSite=Lax` را به `/auth/*` می‌فرستد.
- `mode: 'bff'` بگذارید و `getAccessToken` ندهید؛ اگر بدهید، SDK آن را پاک می‌کند.
- درخواست‌های `user-management` به `/api/v1/clients/{clientId}/…` و درخواست‌های
  `account` به `/api/v1/account/*` از همان Origin اپ/BFF انجام می‌شوند.
- ماژول `account` روی Origin خود IdP اجرا می‌شود و با کوکی نشست IdP احراز می‌شود؛
  Refresh Token و توکن هرگز به JavaScript نمی‌رسد.
- CSRF: مسیرهای تغییردهنده باید با SameSite و توکن CSRF سمت BFF محافظت شوند؛ MFE
  کوکی را مستقیم نمی‌خواند.

### 6.2 SPA (فقط اپ‌های کاملاً مورد اعتماد)

- توکن Access فقط در حافظه است و از طریق `getAccessToken` خوانده می‌شود؛ در
  `localStorage`/`sessionStorage`/Cookie نوشته نمی‌شود.
- Refresh Token در SPA تنها در حافظه و ترجیحاً با Silent Renew مبتنی بر BFF.
- `mode: 'spa'` را فقط برای Monorepo/تیم مورد اعتماد فعال کنید؛ میزبان از نظر فنی به توکن
  دسترسی دارد.
- در SPA، `user-management` هدر `Authorization` را از Getter می‌سازد؛ ماژول `account`
  در حالت SPA پشتیبانی نمی‌شود و باید روی Origin IdP با کوکی اجرا شود.
- `clientId` مسیر API همیشه از Config می‌آید، نه از State یا Query کاربر.

### 6.3 قواعد مشترک

- ورود فقط با Redirect سطح‌بالا به Hosted Auth UI؛ هیچ فرم رمز/دکمهٔ سوشال داخل اپ ساخته
  نمی‌شود.
- `client-id` فقط از تنظیمات اپ خوانده شود.
- محتوای Remote فقط از Origin مورد اعتماد و با HTTPS بارگذاری شود؛ Assetها Immutable.
- محتوای MFE با Shadow DOM و `.idpn-root` ایزوله است؛ CSS میزبان نباید Override شود.
- هیچ `postMessage` بدون بررسی `event.origin` و Schema پذیرفته نمی‌شود.

## 7. CSP و Headerهای لازم

Remote/CDN و API همان اپ را Allowlist کنید:

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.example.com;
  connect-src 'self' https://auth.example.com;
  img-src 'self' data: https://auth.example.com;
  style-src 'self' 'unsafe-inline';
  font-src 'self' https://cdn.example.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self' https://auth.example.com
```

- `script-src` باید Origin CDN را داشته باشد؛ Module Federation اسکریپت Remote را در
  زمان اجرا بارگذاری می‌کند.
- `connect-src` باید Origin BFF/IdP را داشته باشد (در BFF معمولاً `'self'` کافی است).
- `style-src 'unsafe-inline'` برای `<style>` تزریق‌شده در Shadow Root لازم است؛ اگر
  Nonce/Hash پشتیبانی می‌کنید، آن را جایگزین کنید. استایل‌ها در Shadow DOM هستند و به
  CSS میزبان نشت نمی‌کنند.
- CDN باید برای اسکریپت‌ها `Access-Control-Allow-Origin` مناسب و
  `Cache-Control: public, max-age=31536000, immutable` برگرداند.
- هدرهای پیشنهادی دیگر: `X-Content-Type-Options: nosniff`،
  `Referrer-Policy: strict-origin-when-cross-origin`،
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`.

## 8. نسخه‌بندی و انتشار

| موضوع | سیاست |
|---|---|
| نسخه SDK | Semantic Versioning؛ تغییر ناسازگار Config/Event = Major جدید |
| نسخه قرارداد | `IDPN_MFE_CONTRACT_VERSION` معادل `MFE_SCHEMA_VERSION` در `@idpn/contracts` |
| Remote | `https://cdn.example.com/idpn-mfe/{version}/remoteEntry.js` |
| Manifest | `https://cdn.example.com/idpn-mfe/manifest.json` (و `mf-manifest.json` هر Build) |
| Web Component | `https://cdn.example.com/idpn-mfe/{version}/web-component.js` |
| پین نسخه | میزبان حداقل Major را پین می‌کند؛ نسخهٔ Minor بدون Deploy میزبان قابل ارتقاست |
| تغییر ناسازگار | Major جدید + مهلت مهاجرت و اعلان قبلی |
| Deprecation | حداقل دو نسخهٔ Minor پیش از حذف |
| Rollback | نسخهٔ قبلی روی CDN نگه داشته می‌شود |

انتشار:

```bash
pnpm --filter @idpn/mfe-sdk run test:coverage
pnpm --filter @idpn/mfe-sdk run build
pnpm --filter @idpn/mfe-sdk publish --access restricted   # Registry داخلی

pnpm --filter @idpn/web run build:mfe   # remoteEntry.js + mf-manifest.json
pnpm --filter @idpn/web run build:wc    # dist-wc/web-component.js
```

پیش از هر انتشار:

1. `IDPN_MFE_SDK_VERSION` و `package.json` هم‌زمان Bump شوند (`version.test.ts`).
2. اگر Config/Event تغییر کرده، `MFE_SCHEMA_VERSION` و
   `IDPN_MFE_CONTRACT_VERSION` هم‌زمان Bump شوند.
3. `pnpm --filter @idpn/mfe-sdk run test` و `pnpm contract:check` سبز باشند؛
   تست `contract.test.ts` هر ناسازگاری بین SDK و `@idpn/contracts` را می‌شکند.
4. Buildهای `build:mfe` و `build:wc` منتشر و نسخهٔ قبلی برای Rollback نگه داشته شود.

## 9. عیب‌یابی

| نشانه | علت احتمالی | راه‌حل |
|---|---|---|
| هیچ چیز رندر نمی‌شود | Bundle بارگذاری نشده یا CSP اسکریپت را بلاک کرده | ترتیب `<script type="module">` را بررسی و `script-src` را اصلاح کنید. |
| `client-id لازم است.` | Attribute `client-id` خالی است | مقدار را از Config اپ بدهید. |
| `module باید user-management یا account باشد.` | المان عمومی بدون `module` معتبر | `module` را روی `<on4net-idpn-mfe>` تنظیم کنید. |
| `IdpnMfeConfig.accessToken is not allowed` | توکن به SDK پاس شده | فقط `getAccessToken` در حالت SPA بدهید. |
| خطای 401 | نشست BFF وجود ندارد | کاربر را به `/login` بفرستید؛ Getter توکن را بررسی کنید. |
| خطای 403 | نقش ادمین اپ یا `clientId` نادرست | `clientId` و Scope `idp.client-admin` را بررسی کنید. |
| استایل‌ها اعمال نمی‌شوند | CSP `style-src` مانع `<style>` شده | `'unsafe-inline'` یا Nonce را اضافه کنید. |
| Module Federation بارگذاری نمی‌شود | اختلاف React یا نسخهٔ Remote | React 19 Singleton و نسخهٔ پین‌شده را بررسی کنید. |
| جهت/Locale اشتباه | `locale` و `dir` ناسازگار | `dir` را صریح بدهید یا از Locale پشتیبانی‌شده استفاده کنید. |
| پس از حذف Route دوباره Mount می‌شود | عدم فراخوانی `unmount` | در Cleanup مربوط به Framework، `mounted.unmount()` را صدا بزنید. |

## 10. چک‌لیست اتصال

- [ ] `clientId` در IdP ثبت و Origin اپ Allowlist شده است.
- [ ] Remote/Web Component با نسخهٔ پین‌شده بارگذاری می‌شود.
- [ ] `clientId` از تنظیمات اپ می‌آید.
- [ ] `mode` درست انتخاب شده و در BFF هیچ Getter توکنی پاس نمی‌شود.
- [ ] `theme`/`locale`/`dir` از Config اپ می‌آیند.
- [ ] `onEvent` فقط برای UI استفاده می‌شود و توکنی جابه‌جا نمی‌کند.
- [ ] Fallback به Hosted Auth برای خطای Remote تست شده است.
- [ ] CSP/CDN Headerها تنظیم شده‌اند.
- [ ] Mount/Unmount دوباره بدون تکرار المان یا Listener کار می‌کند.
- [ ] تست‌های `pnpm --filter @idpn/mfe-sdk run test` و Buildهای `mfe`/`wc` سبز هستند.
