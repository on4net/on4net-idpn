import { AdminApiError } from '@/admin/api-client';
import { translate, type Locale } from '@/i18n';

/** Maps an API/client failure to a localized, non-leaking admin message. */
export function adminErrorMessage(error: unknown, locale: Locale): string {
  if (error instanceof AdminApiError) {
    if (error.kind === 'forbidden') return translate(locale, 'admin.errorForbidden');
    if (error.kind === 'unauthorized') return translate(locale, 'admin.errorUnauthorized');
    if (error.kind === 'network') return translate(locale, 'admin.errorNetwork');
    return error.detail ?? error.message;
  }
  return translate(locale, 'admin.errorGeneric');
}
