import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Colors } from '../design/tokens';
import {
  IconArrowBack,
  IconBrain,
  IconClose,
  IconPhotoCamera,
  IconPhotoLibrary,
} from '../components/ui/Icons';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useFastingLogGuard } from '../hooks/useFastingLogGuard';
import { foodApi, getErrorMessage, logApi, pantryApi } from '../services/api';
import { toLocalDateStr, useDateStore } from '../stores/dateStore';
import type { MealType } from '../utils/mealMeta';
import { getPlanOwnerId } from '../utils/mealPlan';
import { fileToCompressedJpeg } from '../utils/imageToJpeg';
import styles from './AiRecognizePage.module.css';

type Mode = 'choose' | 'photo' | 'text' | 'result';

type IngredientDraft = {
  id: string;
  name: string;
  amountG: string;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  sugar: string;
  brand: string;
  barcode: string;
  servingUnit: string;
  servingSize: string;
};

const SERVING_UNITS = ['g', 'db', 'adag', 'ek', 'szelet'] as const;

const MEALS: MealType[] = ['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK'];

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeUnit(u?: string) {
  const v = String(u || 'g').trim().toLowerCase();
  return (SERVING_UNITS as readonly string[]).includes(v) ? v : 'g';
}

function toDraft(ing: {
  name: string;
  amountG: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  brand?: string;
  barcode?: string;
  servingUnit?: string;
  servingSize?: number;
}): IngredientDraft {
  const servingUnit = normalizeUnit(ing.servingUnit);
  const servingSize =
    ing.servingSize != null && ing.servingSize > 0
      ? ing.servingSize
      : servingUnit === 'g'
        ? ing.amountG
        : ing.amountG;
  return {
    id: uid(),
    name: ing.name,
    amountG: String(Math.round(ing.amountG * 10) / 10),
    kcal: String(Math.round(ing.kcal * 10) / 10),
    protein: String(Math.round(ing.protein * 10) / 10),
    carbs: String(Math.round(ing.carbs * 10) / 10),
    fat: String(Math.round(ing.fat * 10) / 10),
    fiber: ing.fiber != null ? String(Math.round(ing.fiber * 10) / 10) : '',
    sugar: ing.sugar != null ? String(Math.round(ing.sugar * 10) / 10) : '',
    brand: ing.brand?.trim() || '',
    barcode: ing.barcode?.trim() || '',
    servingUnit,
    servingSize: String(Math.round(servingSize * 10) / 10),
  };
}

function parseNum(v: string) {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

type MacroSnap = {
  amountG: number;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  sugar: string;
};

function snapIng(ing: IngredientDraft): MacroSnap {
  return {
    amountG: parseNum(ing.amountG),
    kcal: ing.kcal,
    protein: ing.protein,
    carbs: ing.carbs,
    fat: ing.fat,
    fiber: ing.fiber,
    sugar: ing.sugar,
  };
}

function scaleField(v: string, scale: number) {
  if (!v.trim()) return v;
  const n = parseNum(v);
  if (!Number.isFinite(n)) return v;
  return String(Math.round(n * scale * 10) / 10);
}

function applyAmountScale(
  ing: IngredientDraft,
  cleaned: string,
  baseline: MacroSnap | undefined,
  scaleOn: boolean,
): IngredientDraft {
  if (!scaleOn) return { ...ing, amountG: cleaned };
  const newG = parseNum(cleaned);
  const oldG =
    baseline && Number.isFinite(baseline.amountG) && baseline.amountG > 0
      ? baseline.amountG
      : parseNum(ing.amountG);
  if (!Number.isFinite(oldG) || oldG <= 0 || !Number.isFinite(newG) || newG <= 0) {
    return { ...ing, amountG: cleaned };
  }
  const scale = newG / oldG;
  const src = baseline ?? snapIng(ing);
  return {
    ...ing,
    amountG: cleaned,
    kcal: scaleField(src.kcal, scale),
    protein: scaleField(src.protein, scale),
    carbs: scaleField(src.carbs, scale),
    fat: scaleField(src.fat, scale),
    fiber: scaleField(src.fiber, scale),
    sugar: scaleField(src.sugar, scale),
  };
}

export default function AiRecognizePage() {
  const { t, i18n } = useTranslation();
  const { confirmIfActive, dialog: fastingDialog } = useFastingLogGuard();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const selectedDate = useDateStore((s) => s.selectedDate);
  const mealParam = params.get('mealType') as MealType | null;
  const mealType: MealType = mealParam && MEALS.includes(mealParam) ? mealParam : 'SNACK';
  const returnPath =
    (location.state as { returnPath?: string; pantry?: boolean } | null)?.returnPath || '/home';
  const pantryMode = Boolean((location.state as { pantry?: boolean } | null)?.pantry);

  type PrefillSuggestion = {
    dishName?: string;
    ingredients?: Array<{
      name: string;
      amountG?: number;
      kcal: number;
      protein: number;
      carbs: number;
      fat: number;
      note?: string;
    }>;
  };

  const prefillSuggestion = (location.state as { prefillSuggestion?: PrefillSuggestion } | null)
    ?.prefillSuggestion;

  const goToAddFood = () => {
    if (pantryMode) {
      navigate(returnPath, { replace: true });
      return;
    }
    navigate(returnPath, { replace: true, state: { openAddFood: true, mealType } });
  };

  const [mode, setMode] = useState<Mode>('choose');
  const [text, setText] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStep, setProgressStep] = useState<string>('progressStepPhoto');
  const [saving, setSaving] = useState(false);
  const [dishName, setDishName] = useState('');
  const [ingredients, setIngredients] = useState<IngredientDraft[]>([]);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [showIngredients, setShowIngredients] = useState(true);
  const [scaleWithAmount, setScaleWithAmount] = useState(true);
  const [dishBrand, setDishBrand] = useState('');
  const [dishBarcode, setDishBarcode] = useState('');
  const [dishServingUnit, setDishServingUnit] = useState('g');
  const [dishServingSize, setDishServingSize] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ title: string; message: string; goBack?: boolean } | null>(
    null,
  );

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const prefillAppliedRef = useRef(false);
  const amountBaselineRef = useRef<Record<string, MacroSnap>>({});
  const preparedBaselineRef = useRef<IngredientDraft[] | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isCancelledRef = useRef(false);

  const stopProgress = () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  const cancelRecognize = () => {
    isCancelledRef.current = true;
    stopProgress();
    setBusy(false);
    setProgress(0);
    // Request was already sent and counted on the backend daily quota
    setRemaining((prev) => (prev != null ? Math.max(0, prev - 1) : null));
  };

  const startProgress = (targetMode: 'photo' | 'text') => {
    stopProgress();
    const startStep = targetMode === 'photo' ? 'progressStepPhoto' : 'progressStepText';
    setProgress(8);
    setProgressStep(startStep);

    const startTime = Date.now();
    progressTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      let nextPct = 8;
      let nextStep = startStep;

      if (elapsed < 1.2) {
        nextPct = 8 + (elapsed / 1.2) * 22;
        nextStep = startStep;
      } else if (elapsed < 4.5) {
        const ratio = (elapsed - 1.2) / 3.3;
        nextPct = 30 + ratio * 38;
        nextStep = 'progressStepAnalyze';
      } else if (elapsed < 8.5) {
        const ratio = (elapsed - 4.5) / 4.0;
        nextPct = 68 + ratio * 20;
        nextStep = 'progressStepNutrition';
      } else {
        const extra = elapsed - 8.5;
        nextPct = Math.min(95, 88 + (1 - Math.exp(-extra / 4)) * 7);
        nextStep = 'progressStepFinal';
      }

      setProgress(Math.min(95, Math.round(nextPct)));
      setProgressStep(nextStep);
    }, 120);
  };

  useEffect(() => {
    return () => {
      stopProgress();
    };
  }, []);

  const applyDishMeta = (drafts: IngredientDraft[]) => {
    const first = drafts[0];
    setDishBrand(first?.brand || '');
    setDishBarcode(first?.barcode || '');
    setDishServingUnit(first?.servingUnit || (drafts.length > 1 ? 'adag' : 'g'));
    setDishServingSize(first?.servingSize || '');
  };

  useEffect(() => {
    if (prefillAppliedRef.current || !prefillSuggestion) return;
    prefillAppliedRef.current = true;
    const ings = (prefillSuggestion.ingredients ?? []).filter((i) => i?.name?.trim());
    if (ings.length === 0) return;
    setDishName(
      (prefillSuggestion.dishName || ings[0]?.name || '').trim() || t('aiRecognize.dishName'),
    );
    const drafts = ings.map((ing) => {
      const amountG =
        ing.amountG != null && ing.amountG > 0
          ? ing.amountG
          : Math.max(50, Math.min(400, Math.round((ing.kcal || 100) / 1.5)));
      return toDraft({
        name: ing.name.trim(),
        amountG,
        kcal: ing.kcal,
        protein: ing.protein,
        carbs: ing.carbs,
        fat: ing.fat,
      });
    });
    setIngredients(drafts);
    applyDishMeta(drafts);
    // Meal suggest → default as one dish (not ingredient breakdown).
    setShowIngredients(false);
    setMode('result');
  }, [prefillSuggestion, t]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const totals = useMemo(() => {
    return ingredients.reduce(
      (acc, ing) => ({
        kcal: acc.kcal + (parseNum(ing.kcal) || 0),
        protein: acc.protein + (parseNum(ing.protein) || 0),
        carbs: acc.carbs + (parseNum(ing.carbs) || 0),
        fat: acc.fat + (parseNum(ing.fat) || 0),
        fiber: acc.fiber + (parseNum(ing.fiber) || 0),
        sugar: acc.sugar + (parseNum(ing.sugar) || 0),
        amountG: acc.amountG + (parseNum(ing.amountG) || 0),
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, amountG: 0 },
    );
  }, [ingredients]);

  const per100 = useMemo(() => {
    const g = totals.amountG;
    const to100 = (n: number) => (g > 0 ? Math.round((n / g) * 100 * 10) / 10 : 0);
    return {
      kcal: to100(totals.kcal),
      protein: to100(totals.protein),
      carbs: to100(totals.carbs),
      fat: to100(totals.fat),
      fiber: to100(totals.fiber),
      sugar: to100(totals.sugar),
    };
  }, [totals]);

  const locale = i18n.language?.startsWith('en') ? 'en' : 'hu';

  const onPickFile = (file: File | null) => {
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setImageFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setMode('photo');
  };

  const runRecognize = async (opts: { mode: 'photo' | 'text' }) => {
    isCancelledRef.current = false;
    setBusy(true);
    startProgress(opts.mode);
    try {
      let payload: Parameters<typeof foodApi.aiRecognize>[0];
      if (opts.mode === 'photo') {
        if (!imageFile) {
          stopProgress();
          setBusy(false);
          setProgress(0);
          setDialog({ title: t('food.errorTitle'), message: t('aiRecognize.needPhoto') });
          return;
        }
        const { base64, mimeType } = await fileToCompressedJpeg(imageFile);
        if (isCancelledRef.current) return;
        payload = { mode: 'photo', imageBase64: base64, mimeType, locale };
      } else {
        if (!text.trim()) {
          stopProgress();
          setBusy(false);
          setProgress(0);
          setDialog({ title: t('food.errorTitle'), message: t('aiRecognize.needText') });
          return;
        }
        payload = { mode: 'text', text: text.trim(), locale };
      }

      const res = await foodApi.aiRecognize(payload);
      if (isCancelledRef.current) return;

      stopProgress();
      setProgress(100);
      setProgressStep('progressStepDone');

      await new Promise((r) => setTimeout(r, 260));
      if (isCancelledRef.current) return;

      const drafts = res.ingredients.map(toDraft);
      setDishName(res.dishName || '');
      setIngredients(drafts);
      applyDishMeta(drafts);
      setRemaining(res.remaining);
      setMode('result');
    } catch (e) {
      if (isCancelledRef.current) return;
      stopProgress();
      setDialog({
        title: t('food.errorTitle'),
        message: getErrorMessage(e, t('aiRecognize.failed')),
      });
    } finally {
      if (!isCancelledRef.current) {
        stopProgress();
        setBusy(false);
        setProgress(0);
      }
    }
  };

  const updateIng = (id: string, patch: Partial<IngredientDraft>) => {
    setIngredients((prev) => prev.map((ing) => (ing.id === id ? { ...ing, ...patch } : ing)));
  };

  const captureAmountBaseline = (id: string) => {
    const ing = ingredients.find((i) => i.id === id);
    if (ing) amountBaselineRef.current[id] = snapIng(ing);
  };

  const capturePreparedBaseline = () => {
    preparedBaselineRef.current = ingredients.map((ing) => ({ ...ing }));
    const only = ingredients[0];
    if (only) amountBaselineRef.current[only.id] = snapIng(only);
  };

  const updateAmountG = (id: string, nextAmountRaw: string) => {
    const cleaned = nextAmountRaw.replace(/[^\d.,]/g, '');
    setIngredients((prev) =>
      prev.map((ing) => {
        if (ing.id !== id) return ing;
        return applyAmountScale(ing, cleaned, amountBaselineRef.current[id], scaleWithAmount);
      }),
    );
  };

  const removeIng = (id: string) => {
    setIngredients((prev) => prev.filter((ing) => ing.id !== id));
  };

  const scalePreparedTotal = (
    field: 'amountG' | 'kcal' | 'protein' | 'carbs' | 'fat',
    nextRaw: string,
  ) => {
    const cleaned = nextRaw.replace(/[^\d.,]/g, '');
    if (ingredients.length === 1) {
      const only = ingredients[0]!;
      if (field === 'amountG') {
        updateAmountG(only.id, cleaned);
        return;
      }
      updateIng(only.id, { [field]: cleaned });
      return;
    }

    if (field === 'amountG') {
      const baseline = preparedBaselineRef.current ?? ingredients;
      const oldTotal = baseline.reduce((s, i) => s + (parseNum(i.amountG) || 0), 0);
      const newTotal = parseNum(cleaned);
      if (!Number.isFinite(oldTotal) || oldTotal <= 0 || !Number.isFinite(newTotal) || newTotal < 0) {
        return;
      }
      const scale = newTotal / oldTotal;
      setIngredients(
        baseline.map((ing) => {
          const oldG = parseNum(ing.amountG);
          if (!Number.isFinite(oldG) || oldG <= 0) return ing;
          const newG = Math.round(oldG * scale * 10) / 10;
          if (!scaleWithAmount) return { ...ing, amountG: String(newG) };
          return {
            ...ing,
            amountG: String(newG),
            kcal: scaleField(ing.kcal, scale),
            protein: scaleField(ing.protein, scale),
            carbs: scaleField(ing.carbs, scale),
            fat: scaleField(ing.fat, scale),
            fiber: scaleField(ing.fiber, scale),
            sugar: scaleField(ing.sugar, scale),
          };
        }),
      );
      return;
    }

    const oldTotal = totals[field];
    const newTotal = parseNum(cleaned);
    if (!Number.isFinite(oldTotal) || oldTotal <= 0 || !Number.isFinite(newTotal) || newTotal < 0) {
      return;
    }
    const scale = newTotal / oldTotal;
    setIngredients((prev) =>
      prev.map((ing) => {
        const n = parseNum(ing[field]);
        if (!Number.isFinite(n)) return ing;
        return { ...ing, [field]: String(Math.round(n * scale * 10) / 10) };
      }),
    );
  };

  const handleSave = async () => {
    if (!ingredients.length) {
      setDialog({ title: t('food.errorTitle'), message: t('aiRecognize.noIngredients') });
      return;
    }

    const parsed = ingredients.map((ing) => ({
      name: ing.name.trim(),
      amountG: parseNum(ing.amountG),
      kcal: parseNum(ing.kcal),
      protein: parseNum(ing.protein),
      carbs: parseNum(ing.carbs),
      fat: parseNum(ing.fat),
      fiber: ing.fiber.trim() ? parseNum(ing.fiber) : undefined,
      sugar: ing.sugar.trim() ? parseNum(ing.sugar) : undefined,
      brand: ing.brand.trim() || undefined,
      barcode: ing.barcode.trim() || undefined,
      servingUnit: normalizeUnit(ing.servingUnit),
      servingSize: parseNum(ing.servingSize),
    }));

    if (
      parsed.some(
        (p) =>
          !p.name ||
          ![p.amountG, p.kcal, p.protein, p.carbs, p.fat].every((n) => Number.isFinite(n) && n >= 0) ||
          p.amountG <= 0 ||
          !Number.isFinite(p.servingSize) ||
          p.servingSize <= 0,
      )
    ) {
      setDialog({ title: t('food.errorTitle'), message: t('aiRecognize.invalidValues') });
      return;
    }

    setSaving(true);
    try {
      if (!pantryMode) await confirmIfActive();
      const round1 = (n: number) => Math.round(n * 10) / 10;
      const totalG = parsed.reduce((s, p) => s + p.amountG, 0);
      const totalMacros = parsed.reduce(
        (acc, p) => ({
          kcal: acc.kcal + p.kcal,
          protein: acc.protein + p.protein,
          carbs: acc.carbs + p.carbs,
          fat: acc.fat + p.fat,
          fiber: acc.fiber + (p.fiber ?? 0),
          sugar: acc.sugar + (p.sugar ?? 0),
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 },
      );

      let preparedFoodId: string | undefined;
      const dishServingN = parseNum(dishServingSize);
      const savedServingSize =
        Number.isFinite(dishServingN) && dishServingN > 0
          ? dishServingN
          : Math.round(totalG * 10) / 10;
      const savedServingUnit = normalizeUnit(dishServingUnit);
      const savedBrand = dishBrand.trim() || parsed[0]?.brand;
      const savedBarcode = dishBarcode.trim() || parsed[0]?.barcode;

      if (saveToLibrary || pantryMode) {
        const to100 = (n: number) =>
          totalG > 0 ? Math.round((n / totalG) * 100 * 10) / 10 : 0;
        const food = await foodApi.create({
          name: dishName.trim() || parsed[0]!.name,
          brand: savedBrand,
          barcode: savedBarcode,
          kcal: to100(totalMacros.kcal),
          protein: to100(totalMacros.protein),
          carbs: to100(totalMacros.carbs),
          fat: to100(totalMacros.fat),
          fiber: totalMacros.fiber > 0 ? to100(totalMacros.fiber) : undefined,
          sugar: totalMacros.sugar > 0 ? to100(totalMacros.sugar) : undefined,
          servingSize: savedServingSize,
          servingUnit: savedServingUnit,
          source: 'USER_SCAN',
          isPrepared: true,
          components: parsed.map((p, i) => ({
            name: p.name,
            amountG: p.amountG,
            kcal: p.kcal,
            protein: p.protein,
            carbs: p.carbs,
            fat: p.fat,
            fiber: p.fiber,
            sugar: p.sugar,
            sortOrder: i,
          })),
        });
        preparedFoodId = food.id;
      }

      const dishLabel = dishName.trim();

      if (pantryMode) {
        const pantryUnit = savedServingUnit === 'db' || savedServingUnit === 'adag' ? 'db' : 'g';
        const pantryQty =
          pantryUnit === 'db'
            ? 1
            : Math.max(1, Math.round(totalG * 10) / 10);
        await pantryApi.add({
          ownerId: getPlanOwnerId() || undefined,
          foodId: preparedFoodId,
          name: dishLabel || parsed[0]!.name,
          quantity: pantryQty,
          unit: pantryUnit,
          source: 'AI',
        });
        setDialog({
          title: t('aiRecognize.savedTitle'),
          message: t('mealPlan.pantryAiSaved'),
          goBack: true,
        });
        return;
      }

      const date = toLocalDateStr(selectedDate);

      if (!showIngredients) {
        await logApi.create({
          ...(preparedFoodId ? { foodId: preparedFoodId } : {}),
          foodName: dishLabel || parsed[0]!.name,
          kcal: round1(totalMacros.kcal),
          protein: round1(totalMacros.protein),
          carbs: round1(totalMacros.carbs),
          fat: round1(totalMacros.fat),
          fiber: totalMacros.fiber > 0 ? round1(totalMacros.fiber) : undefined,
          sugar: totalMacros.sugar > 0 ? round1(totalMacros.sugar) : undefined,
          amount: Math.max(1, Math.round(totalG * 10) / 10),
          mealType,
          source: 'AI',
          date,
          sourcePreparedFoodId: preparedFoodId,
        });
      } else {
        const single = parsed.length === 1;
        const logGroupId = single ? undefined : crypto.randomUUID();
        const logGroupName = single ? undefined : (dishLabel || parsed[0]!.name);
        for (const p of parsed) {
          await logApi.create({
            foodName: single ? dishLabel || p.name : p.name,
            kcal: p.kcal,
            protein: p.protein,
            carbs: p.carbs,
            fat: p.fat,
            fiber: p.fiber,
            sugar: p.sugar,
            amount: p.amountG,
            mealType,
            source: 'AI',
            date,
            logGroupId,
            logGroupName,
            sourcePreparedFoodId: preparedFoodId,
          });
        }
      }

      setDialog({
        title: t('aiRecognize.savedTitle'),
        message: saveToLibrary ? t('aiRecognize.savedLibrary') : t('aiRecognize.savedMeal'),
        goBack: true,
      });
    } catch (e) {
      setDialog({
        title: t('food.errorTitle'),
        message: getErrorMessage(e, t('aiRecognize.saveFailed')),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${styles.screen} page-scroll no-tab`}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={goToAddFood}>
          <IconArrowBack size={22} color={Colors.dashboard.stroke} />
        </button>
        <h1>{t('aiRecognize.screenTitle')}</h1>
        <span style={{ width: 40 }} />
      </header>

      <div className={styles.content}>
            {mode === 'choose' && (
          <>
            <p className={styles.lead}>
              {pantryMode ? t('mealPlan.pantryAiLead') : t('aiRecognize.chooseLead')}
            </p>
            <button type="button" className={styles.modeCard} onClick={() => setMode('photo')}>
              <span className={styles.modeIcon} style={{ background: '#D8EADF' }}>
                <IconPhotoCamera size={24} color={Colors.dashboard.stroke} />
              </span>
              <span className={styles.modeText}>
                <span className={styles.modeTitle}>{t('aiRecognize.fromPhoto')}</span>
                <span className={styles.modeSub}>{t('aiRecognize.fromPhotoDesc')}</span>
              </span>
            </button>
            <button type="button" className={styles.modeCard} onClick={() => setMode('text')}>
              <span className={styles.modeIcon} style={{ background: '#F4E5C2' }}>
                <IconBrain size={24} color={Colors.dashboard.stroke} />
              </span>
              <span className={styles.modeText}>
                <span className={styles.modeTitle}>{t('aiRecognize.fromText')}</span>
                <span className={styles.modeSub}>{t('aiRecognize.fromTextDesc')}</span>
              </span>
            </button>
            <p className={styles.hint}>{t('aiRecognize.limitHint', { limit: 20 })}</p>
          </>
        )}

        {mode === 'photo' && (
          <>
            <p className={styles.lead}>{t('aiRecognize.photoLead')}</p>
            <div className={styles.photoActions}>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={busy}
                onClick={() => cameraInputRef.current?.click()}
              >
                <IconPhotoCamera size={18} color={Colors.dashboard.stroke} />
                {t('aiRecognize.takePhoto')}
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={busy}
                onClick={() => galleryInputRef.current?.click()}
              >
                <IconPhotoLibrary size={18} color={Colors.dashboard.stroke} />
                {t('aiRecognize.pickGallery')}
              </button>
            </div>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className={styles.hiddenInput}
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className={styles.hiddenInput}
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            {previewUrl && (
              <div className={styles.previewWrap}>
                <img src={previewUrl} alt="" className={styles.previewImg} />
                <p className={styles.noStore}>{t('aiRecognize.photoNotStored')}</p>
              </div>
            )}
            {busy ? (
              <>
                <div className={styles.progressCard} aria-live="polite" role="status">
                  <div className={styles.progressHead}>
                    <div className={styles.progressStatus}>
                      <span className={styles.progressDot} />
                      <span className={styles.progressStepText}>
                        {t(`aiRecognize.${progressStep}`, t('aiRecognize.progressStepAnalyze'))}
                      </span>
                    </div>
                    <span className={styles.progressPercent}>{progress}%</span>
                  </div>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${progress}%` }}>
                      <span className={styles.progressStripes}>
                        //////// //////// //////// //////// //////// ////////
                      </span>
                    </div>
                  </div>
                </div>
                <button type="button" className={styles.cancelBtn} onClick={cancelRecognize}>
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={!imageFile}
                  onClick={() => runRecognize({ mode: 'photo' })}
                >
                  {t('aiRecognize.run')}
                </button>
                <button type="button" className={styles.linkBtn} onClick={() => setMode('choose')}>
                  {t('aiRecognize.backToChoose')}
                </button>
              </>
            )}
          </>
        )}

        {mode === 'text' && (
          <>
            <p className={styles.lead}>{t('aiRecognize.textLead')}</p>
            <textarea
              className={styles.textarea}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder={t('aiRecognize.textPlaceholder')}
            />
            {busy ? (
              <>
                <div className={styles.progressCard} aria-live="polite" role="status">
                  <div className={styles.progressHead}>
                    <div className={styles.progressStatus}>
                      <span className={styles.progressDot} />
                      <span className={styles.progressStepText}>
                        {t(`aiRecognize.${progressStep}`, t('aiRecognize.progressStepAnalyze'))}
                      </span>
                    </div>
                    <span className={styles.progressPercent}>{progress}%</span>
                  </div>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${progress}%` }}>
                      <span className={styles.progressStripes}>
                        //////// //////// //////// //////// //////// ////////
                      </span>
                    </div>
                  </div>
                </div>
                <button type="button" className={styles.cancelBtn} onClick={cancelRecognize}>
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={!text.trim()}
                  onClick={() => runRecognize({ mode: 'text' })}
                >
                  {t('aiRecognize.run')}
                </button>
                <button type="button" className={styles.linkBtn} onClick={() => setMode('choose')}>
                  {t('aiRecognize.backToChoose')}
                </button>
              </>
            )}
          </>
        )}

        {mode === 'result' && (
          <>
            {previewUrl && (
              <div className={styles.previewWrap}>
                <img src={previewUrl} alt="" className={styles.previewImg} />
                <p className={styles.noStore}>{t('aiRecognize.photoNotStored')}</p>
              </div>
            )}

            <div className={styles.fieldCard}>
              <label className={styles.fieldLabel}>{t('aiRecognize.dishName')}</label>
              <input
                className={styles.input}
                value={dishName}
                onChange={(e) => setDishName(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={styles.ingredientsToggle}
              data-on={showIngredients || undefined}
              aria-pressed={showIngredients}
              onClick={() => setShowIngredients((v) => !v)}
            >
              <span className={styles.ingredientsToggleLabel}>{t('food.logAsPrepared')}</span>
              <span className={styles.ingredientsSwitch} data-on={showIngredients || undefined}>
                <span className={styles.ingredientsSwitchThumb} />
              </span>
            </button>

            {remaining != null && (
              <p className={styles.hint}>{t('aiRecognize.remaining', { count: remaining })}</p>
            )}

            <label className={styles.preparedCheck}>
              <span className={styles.preparedCheckBox} data-checked={scaleWithAmount || undefined}>
                <input
                  type="checkbox"
                  checked={scaleWithAmount}
                  onChange={(e) => setScaleWithAmount(e.target.checked)}
                />
                {scaleWithAmount ? '✓' : null}
              </span>
              <span className={styles.preparedCheckText}>
                <strong>{t('aiRecognize.scaleWithAmount')}</strong>
                <small>{t('aiRecognize.scaleWithAmountHint')}</small>
              </span>
            </label>

            {!showIngredients ? (
              <div className={styles.preparedDishCard}>
                <div className={styles.preparedDishHead}>
                  <span className={styles.preparedDishBadge}>{t('aiRecognize.preparedDishBadge')}</span>
                  <p className={styles.preparedDishName}>
                    {dishName.trim() || t('aiRecognize.dishName')}
                  </p>
                  {ingredients.length > 1 ? (
                    <p className={styles.preparedDishMeta}>
                      {t('aiRecognize.preparedPartsHint', { count: ingredients.length })}
                    </p>
                  ) : null}
                </div>
                <div className={styles.metaRow}>
                  <label>
                    {t('food.brandOptional')}
                    <input
                      className={styles.input}
                      value={dishBrand}
                      onChange={(e) => setDishBrand(e.target.value)}
                      placeholder={t('food.brandOptional')}
                    />
                  </label>
                  <label>
                    {t('food.barcodeOptional')}
                    <input
                      className={styles.input}
                      value={dishBarcode}
                      onChange={(e) => setDishBarcode(e.target.value)}
                      placeholder={t('food.barcodeOptional')}
                      inputMode="numeric"
                    />
                  </label>
                </div>
                <div className={styles.grid}>
                  <label>
                    {t('aiRecognize.servingUnit')}
                    <select
                      className={styles.input}
                      value={dishServingUnit}
                      onChange={(e) => setDishServingUnit(e.target.value)}
                    >
                      <option value="g">{t('food.unitG')}</option>
                      <option value="db">{t('food.unitDb')}</option>
                      <option value="adag">{t('food.unitAdag')}</option>
                      <option value="ek">{t('food.unitEk')}</option>
                      <option value="szelet">{t('food.unitSzelet')}</option>
                    </select>
                  </label>
                  <label>
                    {t('aiRecognize.servingSizeG')}
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      value={dishServingSize}
                      onChange={(e) => setDishServingSize(e.target.value.replace(/[^\d.,]/g, ''))}
                    />
                  </label>
                  <label>
                    {t('aiRecognize.amountG')}
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      value={
                        ingredients.length === 1
                          ? ingredients[0]!.amountG
                          : String(Math.round(totals.amountG * 10) / 10)
                      }
                      onFocus={capturePreparedBaseline}
                      onChange={(e) => scalePreparedTotal('amountG', e.target.value)}
                    />
                  </label>
                  <label>
                    kcal
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      value={
                        ingredients.length === 1
                          ? ingredients[0]!.kcal
                          : String(Math.round(totals.kcal * 10) / 10)
                      }
                      onChange={(e) => scalePreparedTotal('kcal', e.target.value)}
                    />
                  </label>
                  <label>
                    {t('food.protein')}
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      value={
                        ingredients.length === 1
                          ? ingredients[0]!.protein
                          : String(Math.round(totals.protein * 10) / 10)
                      }
                      onChange={(e) => scalePreparedTotal('protein', e.target.value)}
                    />
                  </label>
                  <label>
                    {t('food.carbs')}
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      value={
                        ingredients.length === 1
                          ? ingredients[0]!.carbs
                          : String(Math.round(totals.carbs * 10) / 10)
                      }
                      onChange={(e) => scalePreparedTotal('carbs', e.target.value)}
                    />
                  </label>
                  <label>
                    {t('food.fat')}
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      value={
                        ingredients.length === 1
                          ? ingredients[0]!.fat
                          : String(Math.round(totals.fat * 10) / 10)
                      }
                      onChange={(e) => scalePreparedTotal('fat', e.target.value)}
                    />
                  </label>
                </div>
                <div className={styles.per100Card}>
                  <div className={styles.per100Title}>{t('aiRecognize.per100gTitle')}</div>
                  <div className={styles.per100Row}>
                    <span>{per100.kcal} kcal</span>
                    <span>
                      F {per100.protein}g · Sz {per100.carbs}g · Zs {per100.fat}g
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h2 className={styles.sectionTitle}>{t('aiRecognize.ingredients')}</h2>

                {ingredients.map((ing) => (
                  <div key={ing.id} className={styles.ingCard}>
                    <div className={styles.ingHead}>
                      <input
                        className={styles.input}
                        value={ing.name}
                        onChange={(e) => updateIng(ing.id, { name: e.target.value })}
                        placeholder={t('food.foodName')}
                      />
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        aria-label={t('common.delete', 'Delete')}
                        onClick={() => removeIng(ing.id)}
                      >
                        <IconClose size={18} color="#B83B3B" />
                      </button>
                    </div>
                    <div className={styles.metaRow}>
                      <label>
                        {t('food.brandOptional')}
                        <input
                          className={styles.input}
                          value={ing.brand}
                          onChange={(e) => updateIng(ing.id, { brand: e.target.value })}
                          placeholder={t('food.brandOptional')}
                        />
                      </label>
                      <label>
                        {t('food.barcodeOptional')}
                        <input
                          className={styles.input}
                          value={ing.barcode}
                          onChange={(e) => updateIng(ing.id, { barcode: e.target.value })}
                          placeholder={t('food.barcodeOptional')}
                          inputMode="numeric"
                        />
                      </label>
                    </div>
                    <div className={styles.grid}>
                      <label>
                        {t('aiRecognize.amountG')}
                        <input
                          className={styles.input}
                          inputMode="decimal"
                          value={ing.amountG}
                          onFocus={() => captureAmountBaseline(ing.id)}
                          onChange={(e) => updateAmountG(ing.id, e.target.value)}
                        />
                      </label>
                      <label>
                        {t('aiRecognize.servingUnit')}
                        <select
                          className={styles.input}
                          value={ing.servingUnit}
                          onChange={(e) => updateIng(ing.id, { servingUnit: e.target.value })}
                        >
                          <option value="g">{t('food.unitG')}</option>
                          <option value="db">{t('food.unitDb')}</option>
                          <option value="adag">{t('food.unitAdag')}</option>
                          <option value="ek">{t('food.unitEk')}</option>
                          <option value="szelet">{t('food.unitSzelet')}</option>
                        </select>
                      </label>
                      <label>
                        {t('aiRecognize.servingSizeG')}
                        <input
                          className={styles.input}
                          inputMode="decimal"
                          value={ing.servingSize}
                          onChange={(e) => updateIng(ing.id, { servingSize: e.target.value })}
                        />
                      </label>
                      <label>
                        kcal
                        <input
                          className={styles.input}
                          inputMode="decimal"
                          value={ing.kcal}
                          onChange={(e) => updateIng(ing.id, { kcal: e.target.value })}
                        />
                      </label>
                      <label>
                        {t('food.protein')}
                        <input
                          className={styles.input}
                          inputMode="decimal"
                          value={ing.protein}
                          onChange={(e) => updateIng(ing.id, { protein: e.target.value })}
                        />
                      </label>
                      <label>
                        {t('food.carbs')}
                        <input
                          className={styles.input}
                          inputMode="decimal"
                          value={ing.carbs}
                          onChange={(e) => updateIng(ing.id, { carbs: e.target.value })}
                        />
                      </label>
                      <label>
                        {t('food.fat')}
                        <input
                          className={styles.input}
                          inputMode="decimal"
                          value={ing.fat}
                          onChange={(e) => updateIng(ing.id, { fat: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                ))}

                <div className={styles.summaryCard}>
                  <div className={styles.summaryTitle}>{t('aiRecognize.summary')}</div>
                  <div className={styles.summaryRow}>
                    <span>{Math.round(totals.kcal)} kcal</span>
                    <span>
                      F {Math.round(totals.protein * 10) / 10}g · Sz{' '}
                      {Math.round(totals.carbs * 10) / 10}g · Zs {Math.round(totals.fat * 10) / 10}g
                    </span>
                  </div>
                </div>
              </>
            )}

            {!pantryMode ? (
            <label className={styles.preparedCheck}>
              <span className={styles.preparedCheckBox} data-checked={saveToLibrary || undefined}>
                <input
                  type="checkbox"
                  checked={saveToLibrary}
                  onChange={(e) => setSaveToLibrary(e.target.checked)}
                />
                {saveToLibrary ? '✓' : null}
              </span>
              <span className={styles.preparedCheckText}>
                <strong>{t('aiRecognize.saveToLibrary')}</strong>
              </span>
            </label>
            ) : null}

            <button
              type="button"
              className={styles.primaryBtn}
              disabled={saving || !ingredients.length}
              onClick={handleSave}
            >
              {saving ? (
                <span className="spinner" style={{ width: 22, height: 22 }} />
              ) : pantryMode ? (
                t('mealPlan.addToPantry')
              ) : (
                t('aiRecognize.addToMeal')
              )}
            </button>
          </>
        )}
      </div>

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ''}
        message={dialog?.message ?? ''}
        confirmLabel={t('common.ok', 'OK')}
        onClose={() => {
          const go = dialog?.goBack;
          setDialog(null);
          if (go) {
            if (pantryMode) navigate(returnPath, { replace: true });
            else navigate(-1);
          }
        }}
      />
      {fastingDialog}
    </div>
  );
}
