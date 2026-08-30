import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconArrowForward,
  IconEmailOutline,
  IconLockOutline,
  IconVisibility,
  IconVisibilityOff,
} from '../components/ui/Icons';
import DoodleCharacter, { SparkleIcon } from '../components/ui/DoodleCharacter';
import { GlassCardSimple } from '../components/ui/GlassCard';
import { useAuthStore } from '../stores/authStore';
import { useAuthError } from '../hooks/useAuthError';
import { Colors, Spacing } from '../design/tokens';
import styles from './Auth.module.css';

/** Basic email format check – same rule as backend (zod email). */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const { resolveError } = useAuthError();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [error, setError] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');

  const doShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 300);
  };

  const handleLogin = async () => {
    const emailValue = email.trim().toLowerCase();
    const passwordValue = password.trim();

    if (!emailValue || !passwordValue) {
      doShake();
      setError(t('auth.loginMissingData'));
      return;
    }
    if (!isValidEmail(emailValue)) {
      doShake();
      setError(t('auth.invalidEmailFormat'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(emailValue, passwordValue);
      navigate('/home', { replace: true });
    } catch (err) {
      doShake();
      setError(resolveError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = () => {
    setForgotMsg(t('auth.forgotPasswordUnavailable'));
    setTimeout(() => setForgotMsg(''), 3500);
  };

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
          <p className={styles.tagline}>{t('auth.healthAndNutrition')}</p>
          <DoodleCharacter size={100} className={styles.doodle} />
        </div>

        <div className={shake ? 'shake' : undefined}>
          <GlassCardSimple
            backgroundColor={Colors.dashboard.card}
            borderWidth={1.2}
            padding={Spacing['3xl']}
            shadowOffset={6}
            customRadius={{
              borderTopLeftRadius: 30,
              borderTopRightRadius: 11,
              borderBottomRightRadius: 34,
              borderBottomLeftRadius: 13,
            }}
          >
            <div className={styles.field}>
              <IconEmailOutline size={18} className={styles.fieldIcon} color="#4f5d77" />
              <input
                className={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                type="email"
                name="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div className={styles.passwordBlock}>
              <div className={styles.field}>
                <IconLockOutline size={18} className={styles.fieldIcon} color="#4f5d77" />
                <input
                  className={`${styles.input} ${styles.inputWithToggle}`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.passwordToggle}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <IconVisibilityOff size={22} color="#4f5d77" />
                  ) : (
                    <IconVisibility size={22} color="#4f5d77" />
                  )}
                </button>
              </div>
              <button type="button" className={styles.forgot} onClick={handleForgotPassword}>
                {t('auth.forgotPassword')}
              </button>
              {forgotMsg && <p className={styles.forgotMsg}>{forgotMsg}</p>}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            <div className={styles.btnOuter}>
              <span className={styles.btnShadow} />
              <button type="button" className={styles.loginBtn} onClick={handleLogin} disabled={loading}>
                {loading ? (
                  <span className="spinner" style={{ width: 22, height: 22, borderTopColor: '#fff' }} />
                ) : (
                  <>
                    <span>{t('auth.loginCta')}</span>
                    <IconArrowForward size={24} color={Colors.dashboard.onSecondary} />
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
          {t('auth.noAccount')}{' '}
          <Link to="/auth/register" className={styles.footerLink}>
            {t('register')}
          </Link>
        </p>
      </div>
    </div>
  );
}
