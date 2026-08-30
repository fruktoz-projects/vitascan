import { useTranslation } from 'react-i18next';
import { ApiError } from '../services/api';

/**
 * Maps ApiError codes and known backend message patterns to fully
 * localised i18n strings. Call resolveError(err) inside a catch block to
 * get the human-readable message for the current locale.
 */
export function useAuthError() {
  const { t } = useTranslation();

  function resolveError(err: unknown): string {
    if (err instanceof ApiError) {
      // Semantic code takes priority
      switch (err.code) {
        case 'AUTH_INVALID_CREDENTIALS':
          return t('auth.errorInvalidCredentials');
        case 'AUTH_TOKEN_EXPIRED':
          return t('auth.loginFailedGeneric');
        case 'AUTH_FORBIDDEN':
          return t('auth.errorForbidden');
        case 'NOT_FOUND':
          return t('auth.errorNotFound');
        case 'CONFLICT_EMAIL':
          return t('auth.errorConflictEmail');
        case 'CONFLICT_USERNAME':
          return t('auth.errorConflictUsername');
        case 'CONFLICT':
          return t('auth.errorGeneric');
        case 'RATE_LIMITED':
          return t('auth.errorRateLimited');
        case 'SERVER_ERROR':
          return t('auth.errorServerError');
        case 'NETWORK_ERROR':
          return t('auth.errorNetworkOffline');
        case 'TIMEOUT':
          return t('auth.errorTimeout');
        case 'MIXED_CONTENT':
          return t('auth.errorMixedContent');
      }

      // Fallback: recognise known backend message patterns
      const msg = err.message ?? '';
      if (/hib.s email|hibás jelszó|hibás email vagy jelszó/i.test(msg)) {
        return t('auth.errorInvalidCredentials');
      }
      if (/email.*foglalt|foglalt.*email/i.test(msg)) {
        return t('auth.errorConflictEmail');
      }
      if (/felhaszn.l.n.v.*foglalt|foglalt.*felhaszn.l.n.v/i.test(msg)) {
        return t('auth.errorConflictUsername');
      }
      if (/túl sok kérés|rate.?limit/i.test(msg)) {
        return t('auth.errorRateLimited');
      }
      if (/szerverhiba|internal server error/i.test(msg)) {
        return t('auth.errorServerError');
      }
      if (/nem érhető el a szerver/i.test(msg)) {
        return t('auth.errorNetworkOffline');
      }
      if (/túl sokáig tartott|megszakadt/i.test(msg)) {
        return t('auth.errorTimeout');
      }
      if (/böngésző blokkolta/i.test(msg)) {
        return t('auth.errorMixedContent');
      }

      // Backend message is still meaningful — return as-is (already clamped by api.ts)
      if (msg.trim()) return msg;
    }

    if (err instanceof Error && err.message.trim()) {
      return err.message;
    }

    return t('auth.errorGeneric');
  }

  return { resolveError };
}
