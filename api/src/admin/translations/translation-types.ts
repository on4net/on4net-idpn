import type { LocaleSettings } from '../../translations/locale-settings.js';

export interface TranslationClient {
  /** Internal UUID used for audit targets and relation filters. */
  id: string;
  clientId: string;
  settings: LocaleSettings;
}

export interface TranslationLocaleSummary {
  locale: string;
  count: number;
  updatedAt: string;
}

export interface ApplyOverridesInput {
  updatedBy: string;
  /** Version to persist when at least one row changes. */
  version: string;
  at: Date;
}

export interface ApplyOverridesResult {
  /** Sorted keys whose stored value actually changed. */
  changedKeys: string[];
  currentVersion: string;
}

export interface DeleteLocaleResult {
  deletedKeys: string[];
  currentVersion: string;
}

/** Persistence port for per-client translation administration. */
export interface AdminTranslationRepository {
  findClient(clientId: string): Promise<TranslationClient | null>;
  updateLocaleSettings(clientId: string, settings: LocaleSettings): Promise<LocaleSettings | null>;
  listOverrideLocales(clientId: string): Promise<TranslationLocaleSummary[]>;
  findOverrides(clientId: string, locale: string): Promise<Record<string, string>>;
  applyOverrides(
    clientId: string,
    locale: string,
    messages: Record<string, string>,
    input: ApplyOverridesInput,
  ): Promise<ApplyOverridesResult>;
  deleteLocale(
    clientId: string,
    locale: string,
    input: ApplyOverridesInput,
  ): Promise<DeleteLocaleResult>;
}

/** Cache keys the admin write path must invalidate. */
export interface BundleCacheInvalidator {
  delete(key: string): Promise<void>;
}
