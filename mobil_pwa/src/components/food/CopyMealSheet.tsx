import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { Colors } from '../../design/tokens';
import { IconArrowBack, IconCheck, IconClose, IconDelete } from '../ui/Icons';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  ApiError,
  logApi,
  type CopyLogsResult,
  type MealDaySummary,
  type MealHistoryResult,
  type MealTemplate,
} from '../../services/api';
import { MEAL_META, type MealType } from '../../utils/mealMeta';
import { groupDiaryLogs, type DiaryLogLike } from '../../utils/groupDiaryLogs';
import styles from './CopyMealSheet.module.css';

const MEALS: MealType[] = ['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK'];

const MEAL_I18N: Record<MealType, string> = {
  BREAKFAST: 'food.breakfast',
  TIZORAI: 'food.tizorai',
  LUNCH: 'food.lunch',
  UZSONNA: 'food.uzsonna',
  DINNER: 'food.dinner',
  SNACK: 'food.snack',
};

type TargetLog = {
  foodId?: string | null;
  amount?: number | null;
};

type Props = {
  open: boolean;
  targetDate: string;
  targetMealType: MealType;
  history: MealHistoryResult | null;
  targetLogs: TargetLog[];
  initialSourceDate?: string | null;
  initialSourceMealType?: MealType | null;
  limitWarning?: string | null;
  limitRemaining?: number | null;
  onClose: () => void;
  onCopied: (result: CopyLogsResult) => void;
  onError: (message: string) => void;
};

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isDuplicate(log: DiaryLogLike, targetLogs: TargetLog[]): boolean {
  const foodId = log.foodId as string | null | undefined;
  if (!foodId) return false;
  const amount = Number(log.amount ?? 0);
  return targetLogs.some((t) => {
    if (!t.foodId || t.foodId !== foodId) return false;
    const ta = Number(t.amount ?? 0);
    if (ta <= 0 || amount <= 0) return true;
    return Math.abs(ta - amount) / ta <= 0.1;
  });
}

function entriesFromTemplate(tpl: MealTemplate): DiaryLogLike[] {
  return tpl.items.map((item) => ({
    id: item.id,
    foodName: item.foodName,
    kcal: item.kcal,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
    amount: item.amount,
    foodId: item.foodId,
    logGroupId: item.groupKey,
    logGroupName: item.groupName,
    sourcePreparedFoodId: item.sourcePreparedFoodId,
    sourcePreparedFoodName: item.sourcePreparedFoodName,
  }));
}

function entryKey(entry: { kind: string; log?: { id: string }; logGroupId?: string }): string {
  return entry.kind === 'group' ? `group:${entry.logGroupId}` : `log:${entry.log!.id}`;
}

export default function CopyMealSheet({
  open,
  targetDate,
  targetMealType,
  history,
  targetLogs,
  initialSourceDate = null,
  initialSourceMealType = null,
  limitWarning = null,
  limitRemaining = null,
  onClose,
  onCopied,
  onError,
}: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const [step, setStep] = useState<1 | 2>(1);
  const [sourceMealType, setSourceMealType] = useState<MealType>(targetMealType);
  const [sourceDate, setSourceDate] = useState<string | null>(null);
  const [extended, setExtended] = useState<MealHistoryResult | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [entries, setEntries] = useState<ReturnType<typeof groupDiaryLogs>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [templates, setTemplates] = useState<MealTemplate[]>([]);
  const [sourceTemplateId, setSourceTemplateId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MealTemplate | null>(null);
  const [showNameField, setShowNameField] = useState(false);

  const mealLabel = useCallback(
    (m: MealType) => t(MEAL_I18N[m]),
    [t],
  );

  useEffect(() => {
    if (!open) return;
    const srcMeal = initialSourceMealType ?? targetMealType;
    setSourceMealType(srcMeal);
    setExtended(null);
    setWarning(limitWarning);
    setRemaining(limitRemaining);
    setSubmitting(false);
    setSourceTemplateId(null);
    setTemplateSaved(false);
    setShowNameField(false);
    setDeleteTarget(null);
    if (initialSourceDate) {
      setSourceDate(initialSourceDate);
      setStep(2);
      setTemplateName(
        t('foodLibraryScreen.copyTemplateDefaultName', { meal: t(MEAL_I18N[srcMeal]) }),
      );
    } else {
      setSourceDate(null);
      setStep(1);
      setEntries([]);
      setSelected(new Set());
    }
  }, [open, initialSourceDate, initialSourceMealType, targetMealType, limitWarning, limitRemaining, t]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    logApi
      .templates(sourceMealType)
      .then((res) => {
        if (!cancelled) setTemplates(res.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceMealType]);

  useEffect(() => {
    if (!open || step !== 2 || sourceTemplateId) return;
    if (!sourceDate) return;
    let cancelled = false;
    setLogsLoading(true);
    logApi
      .getByDate(sourceDate, sourceMealType)
      .then((res) => {
        if (cancelled) return;
        const logs = (res.logs ?? []) as DiaryLogLike[];
        const grouped = groupDiaryLogs(logs);
        setEntries(grouped);
        setSelected(new Set(grouped.map(entryKey)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onError(err instanceof ApiError ? err.message : t('foodLibraryScreen.copyError'));
        setStep(1);
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, step, sourceDate, sourceMealType, sourceTemplateId, onError, t]);

  const slot = useMemo(() => {
    const fromExt = extended?.slots[sourceMealType];
    const fromHist = history?.slots[sourceMealType];
    return fromExt ?? fromHist ?? null;
  }, [extended, history, sourceMealType]);

  const openDay = (date: string) => {
    setSourceDate(date);
    setSourceTemplateId(null);
    setWarning(null);
    setTemplateSaved(false);
    setShowNameField(false);
    setTemplateName(t('foodLibraryScreen.copyTemplateDefaultName', { meal: mealLabel(sourceMealType) }));
    setStep(2);
  };

  const openTemplate = (tpl: MealTemplate) => {
    setSourceTemplateId(tpl.id);
    setSourceDate(null);
    setWarning(null);
    setTemplateSaved(false);
    setShowNameField(false);
    const grouped = groupDiaryLogs(entriesFromTemplate(tpl));
    setEntries(grouped);
    setSelected(new Set(grouped.map(entryKey)));
    setStep(2);
  };

  const selectedItems = () => {
    const items: { type: 'log' | 'group'; id: string }[] = [];
    for (const key of selected) {
      const sep = key.indexOf(':');
      const type = key.slice(0, sep) as 'log' | 'group';
      const id = key.slice(sep + 1);
      items.push({ type, id });
    }
    return items;
  };

  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      const res = await logApi.mealHistory({
        before: targetDate,
        days: 90,
        mealType: sourceMealType,
      });
      setExtended(res);
    } catch (err: unknown) {
      onError(err instanceof ApiError ? err.message : t('foodLibraryScreen.copyError'));
    } finally {
      setLoadingOlder(false);
    }
  };

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedMeta = useMemo(() => {
    let logCount = 0;
    let kcal = 0;
    for (const entry of entries) {
      const key = entryKey(entry);
      if (!selected.has(key)) continue;
      if (entry.kind === 'single') {
        logCount += 1;
        kcal += entry.log.kcal ?? 0;
      } else {
        logCount += entry.logs.length;
        kcal += entry.totals.kcal;
      }
    }
    return { logCount, kcal, entryCount: selected.size };
  }, [entries, selected]);

  const submit = async () => {
    if (selected.size === 0 || submitting) return;
    if (!sourceDate && !sourceTemplateId) return;
    setSubmitting(true);
    try {
      const items = selectedItems();
      const result = await logApi.copy({
        date: targetDate,
        mealType: targetMealType,
        ...(sourceTemplateId
          ? { templateId: sourceTemplateId }
          : { sourceDate: sourceDate!, sourceMealType }),
        items,
      });
      onCopied(result);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        const remainingSlots = Math.max(
          0,
          Number(err.payload?.limit ?? 10) - Number(err.payload?.currentCount ?? 0),
        );
        setRemaining(remainingSlots);
        setWarning(t('foodLibraryScreen.copyLimit', { remaining: remainingSlots }));
      } else {
        onError(err instanceof ApiError ? err.message : t('foodLibraryScreen.copyError'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const saveTemplate = async () => {
    if (!sourceDate || selected.size === 0 || savingTemplate) return;
    const name = templateName.trim();
    if (!name) {
      setShowNameField(true);
      return;
    }
    setSavingTemplate(true);
    try {
      const created = await logApi.createTemplate({
        name,
        mealType: sourceMealType,
        sourceDate,
        sourceMealType,
        items: selectedItems(),
      });
      setTemplates((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
      setTemplateSaved(true);
      setShowNameField(false);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        onError(t('foodLibraryScreen.copyTemplateLimit'));
      } else {
        onError(err instanceof ApiError ? err.message : t('foodLibraryScreen.copyTemplateError'));
      }
    } finally {
      setSavingTemplate(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    try {
      await logApi.deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      if (sourceTemplateId === id) {
        setSourceTemplateId(null);
        setStep(1);
      }
    } catch (err: unknown) {
      onError(err instanceof ApiError ? err.message : t('foodLibraryScreen.copyTemplateError'));
    }
  };

  if (!open) return null;

  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'hu-HU';
  const targetDateLabel = parseLocalDate(targetDate).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  });
  const showingOlder = (extended?.days ?? 0) >= 90;

  const formatDayLabel = (date: string) =>
    parseLocalDate(date).toLocaleDateString(locale, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });

  const renderDayRow = (day: MealDaySummary, extra?: string) => (
    <button
      key={`${day.date}-${extra ?? 'day'}`}
      type="button"
      className={styles.dayRow}
      onClick={() => openDay(day.date)}
    >
      <div className={styles.dayLeft}>
        <div className={styles.dayTitle}>{extra ?? formatDayLabel(day.date)}</div>
        <div className={styles.dayMeta}>
          {day.previewNames.join(', ')}
          {day.itemCount > 0
            ? ` · ${t('foodLibraryScreen.copyItemCount', { count: day.itemCount })}`
            : ''}
        </div>
      </div>
      <div className={styles.dayKcal}>{Math.round(day.totals.kcal)} kcal</div>
    </button>
  );

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          {step === 2 ? (
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => {
                setStep(1);
                setSourceDate(null);
                setSourceTemplateId(null);
                setWarning(null);
                setTemplateSaved(false);
                setShowNameField(false);
              }}
              aria-label={t('common.back', 'Vissza')}
            >
              <IconArrowBack size={20} color={Colors.dashboard.stroke} />
            </button>
          ) : (
            <span className={styles.headerSpacer} aria-hidden />
          )}
          <div className={styles.headerText}>
            <h2 id={titleId} className={styles.title}>
              {t('foodLibraryScreen.copySheetTitle', { meal: mealLabel(targetMealType) })}
            </h2>
            <p className={styles.subtitle}>
              {t('foodLibraryScreen.copySheetSubtitle', {
                date: targetDateLabel,
                meal: mealLabel(targetMealType),
              })}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={t('common.close')}>
            <IconClose size={20} color={Colors.dashboard.stroke} />
          </button>
        </div>

        <div className={styles.body}>
          {step === 1 ? (
            <>
              {templates.length > 0 ? (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>{t('foodLibraryScreen.copyTemplates')}</h3>
                  {templates.map((tpl) => (
                    <div key={tpl.id} className={styles.templateRow}>
                      <button
                        type="button"
                        className={`${styles.dayRow} ${styles.templateBtn}`}
                        onClick={() => openTemplate(tpl)}
                      >
                        <div className={styles.dayLeft}>
                          <div className={styles.dayTitle}>{tpl.name}</div>
                          <div className={styles.dayMeta}>
                            {tpl.previewNames.join(', ')}
                            {tpl.itemCount > 0
                              ? ` · ${t('foodLibraryScreen.copyItemCount', { count: tpl.itemCount })}`
                              : ''}
                          </div>
                        </div>
                        <div className={styles.dayKcal}>{Math.round(tpl.totals.kcal)} kcal</div>
                      </button>
                      <button
                        type="button"
                        className={styles.templateDelete}
                        aria-label={t('foodLibraryScreen.copyTemplateDelete')}
                        onClick={() => setDeleteTarget(tpl)}
                      >
                        <IconDelete size={18} color="#b33" />
                      </button>
                    </div>
                  ))}
                </section>
              ) : null}

              {slot?.frequent ? (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    {t('foodLibraryScreen.copyFrequent', { meal: mealLabel(sourceMealType) })}
                  </h3>
                  <button
                    type="button"
                    className={`${styles.dayRow} ${styles.frequentRow}`}
                    onClick={() => openDay(slot.frequent!.date)}
                  >
                    <div className={styles.dayLeft}>
                      <div className={styles.dayTitle}>
                        {t('foodLibraryScreen.copyFrequentTimes', { count: slot.frequent.times })}
                      </div>
                      <div className={styles.dayMeta}>
                        {slot.frequent.previewNames.join(', ')}
                      </div>
                    </div>
                    <div className={styles.dayKcal}>{Math.round(slot.frequent.totals.kcal)} kcal</div>
                  </button>
                </section>
              ) : null}

              <section className={styles.section}>
                {!slot?.days.length && !slot?.frequent && templates.length === 0 ? (
                  <p className={styles.empty}>
                    {t('foodLibraryScreen.copyEmpty', { meal: mealLabel(sourceMealType) })}
                  </p>
                ) : !slot?.days.length ? null : (
                  slot.days.map((day) => renderDayRow(day))
                )}
              </section>

              {!showingOlder ? (
                <button
                  type="button"
                  className={styles.olderBtn}
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? t('common.loading', 'Betöltés...') : t('foodLibraryScreen.copyOlder')}
                </button>
              ) : null}
            </>
          ) : logsLoading ? (
            <div className={styles.center}>
              <div className="spinner" />
            </div>
          ) : (
            <>
            <ul className={styles.checkList}>
              {entries.map((entry) => {
                const key = entryKey(entry);
                const on = selected.has(key);
                const dup =
                  entry.kind === 'single'
                    ? isDuplicate(entry.log, targetLogs)
                    : entry.logs.some((l) => isDuplicate(l, targetLogs));
                const title = entry.kind === 'single' ? entry.log.foodName : entry.title;
                const kcal = entry.kind === 'single' ? entry.log.kcal ?? 0 : entry.totals.kcal;
                const amount =
                  entry.kind === 'single' ? entry.log.amount ?? 0 : entry.totals.amount;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`${styles.checkRow} ${on ? styles.checkOn : ''}`}
                      onClick={() => toggle(key)}
                      aria-pressed={on}
                    >
                      <span className={styles.checkbox} aria-hidden>
                        {on ? <IconCheck size={16} color={Colors.dashboard.stroke} /> : null}
                      </span>
                      <span className={styles.dayLeft}>
                        <span className={styles.dayTitle}>{title}</span>
                        <span className={styles.dayMeta}>
                          {Math.round(amount)}g
                          {entry.kind === 'group'
                            ? ` · ${t('food.logGroupParts', { count: entry.logs.length })}`
                            : ''}
                          {dup ? ` · ${t('foodLibraryScreen.copyAlreadyLogged')}` : ''}
                        </span>
                      </span>
                      <span className={styles.dayKcal}>{Math.round(kcal)} kcal</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className={styles.stepActions}>
              {sourceDate ? (
                <div className={styles.saveBlock}>
                  {showNameField ? (
                    <input
                      className={styles.nameInput}
                      value={templateName}
                      onChange={(e) => {
                        setTemplateName(e.target.value);
                        setTemplateSaved(false);
                      }}
                      maxLength={60}
                      placeholder={t('foodLibraryScreen.copyTemplateName')}
                      aria-label={t('foodLibraryScreen.copyTemplateName')}
                    />
                  ) : null}
                  <button
                    type="button"
                    className={styles.saveBtn}
                    onClick={() => {
                      if (!showNameField) {
                        setShowNameField(true);
                        if (!templateName) {
                          setTemplateName(
                            t('foodLibraryScreen.copyTemplateDefaultName', {
                              meal: mealLabel(sourceMealType),
                            }),
                          );
                        }
                        return;
                      }
                      void saveTemplate();
                    }}
                    disabled={savingTemplate || selected.size === 0 || templateSaved}
                  >
                    {savingTemplate
                      ? t('foodLibraryScreen.copyTemplateSaving')
                      : templateSaved
                        ? t('foodLibraryScreen.copyTemplateSaved')
                        : t('foodLibraryScreen.copyTemplateSave')}
                  </button>
                </div>
              ) : null}
              {warning ? <p className={styles.warning}>{warning}</p> : null}
              <button
                type="button"
                className={styles.cta}
                onClick={() => void submit()}
                disabled={
                  submitting ||
                  selected.size === 0 ||
                  (remaining != null && selectedMeta.logCount > remaining)
                }
              >
                {submitting
                  ? t('common.loading', 'Betöltés...')
                  : t('foodLibraryScreen.copyAdd', {
                      count: selectedMeta.entryCount,
                      kcal: Math.round(selectedMeta.kcal),
                    })}
              </button>
            </div>
            </>
          )}
        </div>

        {step === 1 ? (
          <div className={styles.mealChips}>
            {MEALS.map((m) => {
              const meta = MEAL_META[m];
              const on = sourceMealType === m;
              return (
                <button
                  key={m}
                  type="button"
                  className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                  onClick={() => {
                    setSourceMealType(m);
                    setExtended(null);
                  }}
                  style={on ? { background: meta.bg } : undefined}
                >
                  {mealLabel(m)}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        visible={!!deleteTarget}
        title={t('foodLibraryScreen.copyTemplateDeleteTitle')}
        message={t('foodLibraryScreen.copyTemplateDeleteMessage', {
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('foodLibraryScreen.copyTemplateDelete')}
        cancelLabel={t('common.cancel', 'Mégse')}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
        destructive
      />
    </div>
  );
}
