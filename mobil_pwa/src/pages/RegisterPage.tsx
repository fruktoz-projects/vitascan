import { useState } from 'react';
import type { ComponentType } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconArrowForward,
  IconCheck,
  IconEmailOutline,
  IconLockOutline,
  IconPersonOutline,
  IconVisibility,
  IconVisibilityOff,
  type AppIconProps,
} from '../components/ui/Icons';
import { CharacterIcon, SparkleIcon } from '../components/ui/DoodleCharacter';
import { GlassCardSimple } from '../components/ui/GlassCard';
import { useAuthStore } from '../stores/authStore';
import { useAuthError } from '../hooks/useAuthError';
import { Colors, Spacing } from '../design/tokens';
import styles from './Auth.module.css';

/** Basic email format check – same rule as backend (zod email). */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Username rules must match backend: /^[a-zA-Z0-9_]+$/, min 3, max 30. */
function isValidUsername(value: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(value);
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  icon: Icon,
  type = 'text',
  autoComplete,
  name,
  showPasswordToggle = false,
  passwordVisible = false,
  onTogglePassword,
  toggleLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  icon: ComponentType<AppIconProps>;
  type?: string;
  autoComplete?: string;
  name?: string;
  showPasswordToggle?: boolean;
  passwordVisible?: boolean;
  onTogglePassword?: () => void;
  toggleLabel?: string;
}) {
  const inputType =
    showPasswordToggle ? (passwordVisible ? 'text' : 'password') : type;

  return (
    <div className={styles.fieldWrap}>
      <label className={styles.fieldLabel}>{label}</label>
      <div className={styles.field}>
        <Icon size={18} className={styles.fieldIcon} color="#4f5d77" />
        <input
          className={`${styles.input}${showPasswordToggle ? ` ${styles.inputWithToggle}` : ''}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={inputType}
          name={name}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {showPasswordToggle && onTogglePassword && (
          <button
            type="button"
            className={styles.passwordToggle}
            onClick={onTogglePassword}
            aria-label={toggleLabel}
            tabIndex={-1}
          >
            {passwordVisible ? (
              <IconVisibilityOff size={22} color="#4f5d77" />
            ) : (
              <IconVisibility size={22} color="#4f5d77" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export default function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const register = useAuthStore((s) => s.register);
  const { resolveError } = useAuthError();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [error, setError] = useState('');

  const doShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 300);
  };

  const handleRegister = async () => {
    const usernameValue = username.trim();
    const emailValue = email.trim().toLowerCase();
    const passwordValue = password.trim();
    const password2Value = password2.trim();

    if (!usernameValue || !emailValue || !passwordValue) {
      doShake();
      setError(t('auth.registerMissingData'));
      return;
    }
    if (usernameValue.length < 3) {
      doShake();
      setError(t('auth.usernameTooShort'));
      return;
    }
    if (!isValidUsername(usernameValue)) {
      doShake();
      setError(t('auth.usernameInvalidChars'));
      return;
    }
    if (!isValidEmail(emailValue)) {
      doShake();
      setError(t('auth.invalidEmailFormat'));
      return;
    }
    if (passwordValue !== password2Value) {
      doShake();
      setError(t('auth.passwordMismatch'));
      return;
    }
    if (passwordValue.length < 8) {
      doShake();
      setError(t('auth.weakPasswordMessage'));
      return;
    }
    if (passwordValue.length > 72) {
      doShake();
      setError(t('auth.passwordTooLong'));
      return;
    }
    if (!accepted) {
      doShake();
      setError(t('auth.gdprRequired'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await register(usernameValue, emailValue, passwordValue);
      navigate('/home', { replace: true });
    } catch (err) {
      doShake();
      setError(resolveError(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleLabel = showPassword ? t('auth.hidePassword') : t('auth.showPassword');

  return (
    <div className={`${styles.screen} page-scroll no-tab`}>
      <div className={`${styles.blob} ${styles.blob1}`} />
      <div className={`${styles.blob} ${styles.blob2}`} />
      <div className={`${styles.blob} ${styles.blob3}`} />

      <div className={styles.content}>
        <div className={styles.logoArea}>
          <div className={styles.titleWrap}>
            <h1 className={styles.appName}>Vitascan</h1>
            <SparkleIcon className={styles.sparkle} color={Colors.dashboard.stroke} />
          </div>
          <p className={styles.tagline}>{t('auth.joinCommunity')}</p>
          <CharacterIcon size={100} />
        </div>

        <div className={shake ? 'shake' : undefined}>
          <GlassCardSimple
            backgroundColor={Colors.dashboard.card}
            borderWidth={1.2}
            padding={Spacing['3xl']}
            shadowOffset={6}
            customRadius={{
              borderTopLeftRadius: 28,
              borderTopRightRadius: 12,
              borderBottomRightRadius: 32,
              borderBottomLeftRadius: 14,
            }}
          >
            <div className={styles.fields}>
              <Field
                label={t('username')}
                value={username}
                onChange={setUsername}
                placeholder={t('auth.usernamePlaceholder')}
                icon={IconPersonOutline}
                name="username"
                autoComplete="username"
              />
              <Field
                label={t('email')}
                value={email}
                onChange={setEmail}
                placeholder={t('auth.emailPlaceholder')}
                icon={IconEmailOutline}
                type="email"
                name="email"
                autoComplete="email"
              />
              <Field
                label={t('auth.passwordMin')}
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
                icon={IconLockOutline}
                type="password"
                name="new-password"
                autoComplete="new-password"
                showPasswordToggle
                passwordVisible={showPassword}
                onTogglePassword={() => setShowPassword((v) => !v)}
                toggleLabel={toggleLabel}
              />
              <Field
                label={t('auth.confirmPassword')}
                value={password2}
                onChange={setPassword2}
                placeholder="••••••••"
                icon={IconLockOutline}
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                showPasswordToggle
                passwordVisible={showPassword}
                onTogglePassword={() => setShowPassword((v) => !v)}
                toggleLabel={toggleLabel}
              />
              {password2.trim() !== '' && password.trim() !== password2.trim() && (
                <p className={styles.mismatch}>⚠️ {t('auth.passwordMismatchInline')}</p>
              )}
            </div>

            <button type="button" className={styles.checkRow} onClick={() => setAccepted(!accepted)}>
              <span className={`${styles.checkbox} ${accepted ? styles.checkboxOn : ''}`}>
                {accepted && <IconCheck size={16} color={Colors.dashboard.stroke} />}
              </span>
              <span className={styles.checkText}>
                {t('auth.acceptPrefix')} <span className={styles.checkLink}>{t('auth.privacyPolicy')}</span> (GDPR)
              </span>
            </button>

            {error && <p className={styles.error}>{error}</p>}

            <div className={styles.btnOuter}>
              <span className={styles.registerShadow} />
              <button
                type="button"
                className={styles.registerBtn}
                onClick={handleRegister}
                disabled={!accepted || loading}
              >
                {loading ? (
                  <span className="spinner" style={{ width: 22, height: 22 }} />
                ) : (
                  <>
                    <span>{t('auth.registerCta')}</span>
                    <IconArrowForward size={22} color={Colors.dashboard.stroke} />
                  </>
                )}
              </button>
            </div>
          </GlassCardSimple>
        </div>

        <div className={styles.divider}>
          <span className={styles.dividerLine} />
          <span className={styles.dividerLabel}>{t('common.or')}</span>
          <span className={styles.dividerLine} />
        </div>

        <p className={styles.footer}>
          {t('auth.hasAccount')}{' '}
          <Link to="/auth/login" className={styles.footerLink}>
            {t('auth.loginLink')}
          </Link>
        </p>
      </div>
    </div>
  );
}
