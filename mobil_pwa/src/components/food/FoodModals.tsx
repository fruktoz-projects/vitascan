import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  IconAdd,
  IconAddCircle,
  IconApple,
  IconArrowBack,
  IconBolt,
  IconBrain,
  IconChevronRight,
  IconClose,
  IconDelete,
  IconEarth,
  IconEdit,
  IconHeart,
  IconHeartOutline,
  IconInfoOutline,
  IconLeaf,
  IconPeopleOutline,
  IconPhotoCamera,
  IconPhotoLibrary,
  IconPieChartOutline,
  IconQrCodeScanner,
  IconRemove,
  IconRestaurantOutline,
  IconScaleOutline,
  IconScience,
  IconSearch,
  IconThumbDown,
  IconThumbUp,
  IconVerified,
} from '../ui/Icons';
import { GlassCardSimple } from '../ui/GlassCard';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useFastingLogGuard } from '../../hooks/useFastingLogGuard';
import { SwipeDeleteRow } from '../ui/SwipeDeleteRow';
import { adminApi, foodApi, getErrorMessage, logApi, pantryApi, type Food, type FoodOrigin, type FoodStatus } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Colors } from '../../design/tokens';
import { toLocalDateStr, useDateStore } from '../../stores/dateStore';
import { fileToCompressedJpeg } from '../../utils/imageToJpeg';
import {
  bumpFoodOpen,
  loadFoodOpenCounts,
  loadFoodSearchHistory,
  matchSearchSuggestions,
  rankFoodsByOpens,
  rememberFoodSearch,
} from '../../utils/foodSearchPrefs';
import styles from './FoodModals.module.css';

type MealType = 'BREAKFAST' | 'TIZORAI' | 'LUNCH' | 'UZSONNA' | 'DINNER' | 'SNACK';

const MEAL_TYPES: MealType[] = ['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK'];

const SERVING_UNITS = ['g', 'db', 'adag', 'ek', 'szelet'] as const;
type ServingUnitCode = (typeof SERVING_UNITS)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLocalFoodId(id: string | null | undefined): boolean {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Component macros are stored for these grams — never use servingSize for this scale. */
function preparedRecipeGrams(components: Array<{ amountG?: number | null }>): number {
  const sum = components.reduce((s, c) => s + (c.amountG || 0), 0);
  return sum > 0 ? sum : 1;
}

function normalizeServingUnit(raw?: string | null): ServingUnitCode {
  const v = String(raw || 'g').trim().toLowerCase();
  return (SERVING_UNITS as readonly string[]).includes(v) ? (v as ServingUnitCode) : 'g';
}

function gramsPerServingUnit(food: Pick<Food, 'servingSize' | 'servingUnit'>): number {
  const size = food.servingSize != null && food.servingSize > 0 ? food.servingSize : 100;
  return size;
}

function defaultQtyForUnit(unit: ServingUnitCode, gramsPerUnit: number): number {
  return unit === 'g' ? Math.round(gramsPerUnit * 10) / 10 : 1;
}

function qtyToGrams(qty: number, displayUnit: ServingUnitCode, gramsPerUnit: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return displayUnit === 'g' ? qty : qty * gramsPerUnit;
}

function macrosForGrams(
  per100: { kcal: number; protein: number; carbs: number; fat: number; sugar?: number | null; fiber?: number | null },
  grams: number,
) {
  const scale = grams / 100;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    kcal: Math.round(per100.kcal * scale),
    protein: round1(per100.protein * scale),
    carbs: round1(per100.carbs * scale),
    fat: round1(per100.fat * scale),
    sugar: per100.sugar != null ? round1(per100.sugar * scale) : null,
    fiber: per100.fiber != null ? round1(per100.fiber * scale) : null,
  };
}

function SectionIcon({
  children,
  background,
}: {
  children: ReactNode;
  background: string;
}) {
  return (
    <span className={styles.sectionIconCircle} style={{ background }}>
      {children}
    </span>
  );
}

function ServingUnitInfoPopup({
  open,
  onClose,
  title,
  subtitle,
  macros,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  macros: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    sugar?: number | null;
    fiber?: number | null;
  } | null;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className={styles.unitMacrosOverlay} role="presentation" onClick={onClose}>
      <div
        className={styles.servingInfoCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="serving-info-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.servingInfoHead}>
          <IconInfoOutline size={22} color={Colors.dashboard.stroke} />
          <h2 id="serving-info-title" className={styles.servingInfoTitle}>
            {title}
          </h2>
        </div>
        {subtitle ? <p className={styles.servingInfoSub}>{subtitle}</p> : null}
        {macros ? (
          <div className={styles.servingInfoGrid}>
            <div className={styles.servingInfoKcal}>
              <IconBolt size={18} color={Colors.dashboard.nutritionIcon} />
              <span>{macros.kcal} kcal</span>
            </div>
            <div className={styles.servingInfoMacro}>
              <span className={styles.servingInfoMacroLabel}>{t('food.protein')}</span>
              <span className={styles.servingInfoMacroValue}>{macros.protein}g</span>
            </div>
            <div className={styles.servingInfoMacro}>
              <span className={styles.servingInfoMacroLabel}>{t('food.carbs')}</span>
              <span className={styles.servingInfoMacroValue}>{macros.carbs}g</span>
            </div>
            <div className={styles.servingInfoMacro}>
              <span className={styles.servingInfoMacroLabel}>{t('food.fat')}</span>
              <span className={styles.servingInfoMacroValue}>{macros.fat}g</span>
            </div>
            {macros.fiber != null ? (
              <div className={styles.servingInfoMacro}>
                <span className={styles.servingInfoMacroLabel}>{t('food.fiber')}</span>
                <span className={styles.servingInfoMacroValue}>{macros.fiber}g</span>
              </div>
            ) : null}
            {macros.sugar != null ? (
              <div className={styles.servingInfoMacro}>
                <span className={styles.servingInfoMacroLabel}>{t('food.sugar')}</span>
                <span className={styles.servingInfoMacroValue}>{macros.sugar}g</span>
              </div>
            ) : null}
          </div>
        ) : (
          <p className={styles.servingInfoEmpty}>{t('food.servingInfoNeedMacros')}</p>
        )}
        <button type="button" className={styles.servingInfoClose} onClick={onClose}>
          {t('common.ok', 'OK')}
        </button>
      </div>
    </div>
  );
}

function foodNameSizeClass(name: string): string {
  const len = name.trim().length;
  if (len > 32) return `${styles.foodName} ${styles.foodNameLg}`;
  if (len > 16) return `${styles.foodName} ${styles.foodNameMd}`;
  return styles.foodName;
}

/** Márka csak ha van és nem egyezik a termék nevével. */
export function distinctBrand(name: string | null | undefined, brand?: string | null): string | null {
  const b = brand?.trim();
  if (!b) return null;
  const n = (name ?? '').trim();
  if (n && b.toLowerCase() === n.toLowerCase()) return null;
  return b;
}

type FilterTab = 'recent' | 'favorites' | 'frequent' | 'mine';

const FILTER_TABS: { id: FilterTab; labelKey: string }[] = [
  { id: 'recent', labelKey: 'food.tabRecent' },
  { id: 'favorites', labelKey: 'food.tabFavorites' },
  { id: 'frequent', labelKey: 'food.tabFrequent' },
  { id: 'mine', labelKey: 'food.tabMine' },
];

function resolveOrigin(item: Food): FoodOrigin {
  if (item.origin === 'off' || item.origin === 'usda' || item.origin === 'local') return item.origin;
  if (item.externalId?.startsWith('usda:')) return 'usda';
  if (item.externalId?.startsWith('off:')) return 'off';
  if (item.origin === 'external') return 'off';
  return 'local';
}

function OriginIcon({ item }: { item: Food }) {
  const origin = resolveOrigin(item);
  const title =
    origin === 'usda' ? 'USDA' : origin === 'off' ? 'Open Food Facts' : 'Saját adatbázis';
  return (
    <span className={styles.originIcon} aria-hidden title={title}>
      {origin === 'usda' ? (
        <IconScience size={18} color={Colors.dashboard.stroke} />
      ) : origin === 'off' ? (
        <IconEarth size={18} color={Colors.dashboard.stroke} />
      ) : (
        <IconLeaf size={18} color={Colors.dashboard.stroke} />
      )}
    </span>
  );
}

interface FoodDetailModalProps {
  food: Food | null;
  visible: boolean;
  onClose: () => void;
  onLogAdded?: () => void;
  onFoodDeleted?: (id: string) => void;
  logSource?: 'SCAN' | 'SEARCH' | 'MANUAL';
  initialMealType?: MealType;
  intent?: 'log' | 'pantry';
  pantryOwnerId?: string;
  onPantryAdded?: () => void;
}

function MacroBar({
  label,
  grams,
  percent,
  color,
  rotation = 0,
  sugarNote,
}: {
  label: string;
  grams: number;
  percent: number;
  color: string;
  rotation?: number;
  sugarNote?: string;
}) {
  const width = Math.max(4, Math.min(100, percent));
  return (
    <div className={styles.macroBarRow}>
      <div className={styles.macroLabelRow}>
        <span className={styles.macroLabel}>
          {label} ({Math.round(percent)}%)
        </span>
        <span className={styles.macroPct}>{grams}g</span>
      </div>
      <div className={styles.macroTrack}>
        <div
          className={styles.macroFill}
          style={{
            width: `${width}%`,
            background: color,
            transform: `rotate(${rotation}deg)`,
          }}
        />
      </div>
      {sugarNote ? <p className={styles.sugarNote}>{sugarNote}</p> : null}
    </div>
  );
}

function VoteButtons({
  food,
  onVoted,
}: {
  food: Food;
  onVoted: (score: number, myVote: 1 | -1 | null, status?: FoodStatus) => void;
}) {
  const { t } = useTranslation();
  const [myVote, setMyVote] = useState<1 | -1 | null>(food.myVote ?? null);
  const [score, setScore] = useState(food.score ?? 0);
  const [status, setStatus] = useState<FoodStatus>(food.status ?? 'UNVERIFIED');
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setHydrating(true);
    setMyVote(food.myVote ?? null);
    setScore(food.score ?? 0);
    setStatus(food.status ?? 'UNVERIFIED');

    (async () => {
      if (!food.id || String(food.id).startsWith('off_')) {
        if (!cancelled) setHydrating(false);
        return;
      }
      try {
        const fresh = await foodApi.getById(food.id);
        if (cancelled) return;
        setScore(fresh.score ?? 0);
        setMyVote(fresh.myVote ?? null);
        setStatus(fresh.status ?? 'UNVERIFIED');
        onVoted(fresh.score ?? 0, fresh.myVote ?? null, fresh.status);
      } catch {
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // csak food.id váltáskor töltünk újra
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [food.id]);

  const handleVote = async (value: 1 | -1) => {
    if (loading || hydrating) return;
    setLoading(true);
    const prev = { score, myVote, status };
    // optimistic
    if (myVote === value) {
      setMyVote(null);
      setScore((s) => s - value);
    } else if (myVote == null) {
      setMyVote(value);
      setScore((s) => s + value);
    } else {
      setMyVote(value);
      setScore((s) => s - myVote + value);
    }

    try {
      await foodApi.vote(food.id, value);
      const fresh = await foodApi.getById(food.id);
      setScore(fresh.score ?? 0);
      setMyVote(fresh.myVote ?? null);
      setStatus(fresh.status ?? 'UNVERIFIED');
      onVoted(fresh.score ?? 0, fresh.myVote ?? null, fresh.status);
    } catch {
      setScore(prev.score);
      setMyVote(prev.myVote);
      setStatus(prev.status);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.voteBlock}>
      <div className={styles.voteHeader}>
        <div className={styles.voteHeaderLeft}>
          <IconPeopleOutline size={24} color={Colors.dashboard.stroke} />
          <span className={styles.voteTitle}>{t('food.communityRating')}</span>
        </div>
        {status === 'VERIFIED' && <IconVerified size={28} color="#00E676" />}
      </div>

      <div className={styles.voteRail}>
        <button
          type="button"
          className={styles.voteBtnWrap}
          onClick={() => handleVote(-1)}
          disabled={loading || hydrating}
          aria-pressed={myVote === -1}
        >
          <span className={styles.voteBtnShadow} />
          <span
            className={`${styles.voteBtnInner} ${styles.voteBtnDown} ${myVote === -1 ? styles.voteBtnSelected : ''}`}
          >
            <IconThumbDown size={16} color="#D32F2F" />
            <span className={styles.voteTextDown}>{t('food.inaccurate').toUpperCase()}</span>
          </span>
        </button>

        <div className={styles.voteScoreWrap}>
          {hydrating || loading ? (
            <span className="spinner" style={{ width: 18, height: 18 }} />
          ) : (
            <span className={styles.voteScore}>
              {score > 0 ? '+' : ''}
              {score}
            </span>
          )}
        </div>

        <button
          type="button"
          className={styles.voteBtnWrap}
          onClick={() => handleVote(1)}
          disabled={loading || hydrating}
          aria-pressed={myVote === 1}
        >
          <span className={styles.voteBtnShadow} />
          <span
            className={`${styles.voteBtnInner} ${styles.voteBtnUp} ${myVote === 1 ? styles.voteBtnSelected : ''}`}
          >
            <IconThumbUp size={16} color="#388E3C" />
            <span className={styles.voteTextUp}>{t('food.accurate').toUpperCase()}</span>
          </span>
        </button>
      </div>

      <p className={styles.voteFooter}>{t('food.verificationNote')}</p>
    </div>
  );
}

type FoodEditEntry = { id: string; username: string; createdAt: string };

function EditHistoryCard({ foodId }: { foodId: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<FoodEditEntry[] | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await foodApi.editHistory(foodId);
      setEdits(res.edits);
    } catch {
      setEdits([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && edits == null && !loading) void load();
  };

  const formatWhen = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(i18n.language === 'hu' ? 'hu-HU' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
      <div className={styles.editHistoryCard}>
        <button type="button" className={styles.editHistoryToggle} onClick={toggle} aria-expanded={open}>
          <span className={styles.editHistoryTitle}>{t('food.editHistory')}</span>
          <span className={`${styles.editHistoryChevron} ${open ? styles.editHistoryChevronOpen : ''}`}>
            <IconChevronRight size={20} color={Colors.dashboard.stroke} />
          </span>
        </button>
        {open && (
          <div className={styles.editHistoryBody}>
            {loading || edits == null ? (
              <p className={styles.editHistoryLoading}>{t('common.loading', 'Betöltés...')}</p>
            ) : edits.length === 0 ? (
              <p className={styles.editHistoryEmpty}>{t('food.editHistoryEmpty')}</p>
            ) : (
              edits.map((e) => (
                <div key={e.id} className={styles.editHistoryRow}>
                  <span className={styles.editHistoryUser}>{e.username}</span>
                  <span className={styles.editHistoryTime}>{formatWhen(e.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </GlassCardSimple>
  );
}

export function FoodDetailModal({
  food,
  visible,
  onClose,
  onLogAdded,
  onFoodDeleted,
  logSource = 'SEARCH',
  initialMealType = 'SNACK',
  intent = 'log',
  pantryOwnerId,
  onPantryAdded,
}: FoodDetailModalProps) {
  const { t } = useTranslation();
  const { confirmIfActive, dialog: fastingDialog } = useFastingLogGuard();
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const selectedDate = useDateStore((s) => s.selectedDate);
  const [amount, setAmount] = useState('100');
  const [displayUnit, setDisplayUnit] = useState<ServingUnitCode>('g');
  const [mealType, setMealType] = useState<MealType>(initialMealType);
  const [adding, setAdding] = useState(false);
  const [currentFood, setCurrentFood] = useState<Food | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [showIngredients, setShowIngredients] = useState(false);
  const [confirmDeleteFood, setConfirmDeleteFood] = useState(false);
  const [deletingFood, setDeletingFood] = useState(false);

  useEffect(() => {
    setCurrentFood(food);
  }, [food]);

  useEffect(() => {
    if (visible && food) {
      setMealType(initialMealType);
      const unit = normalizeServingUnit(food.servingUnit);
      const gpu = gramsPerServingUnit(food);
      setDisplayUnit(unit);
      const initial = defaultQtyForUnit(unit, gpu);
      setAmount(String(Number.isInteger(initial) ? initial : Math.round(initial * 10) / 10));
      setEditOpen(false);
      setShowIngredients(false);
      setConfirmDeleteFood(false);
      // Load components for prepared foods if missing
      if (food.isPrepared && !(food.components?.length) && isLocalFoodId(food.id)) {
        foodApi.getById(food.id).then((full) => {
          setCurrentFood(full);
        }).catch(() => {});
      }
    }
  }, [visible, initialMealType, food]);

  if (!visible || !currentFood) return null;

  const canEditFood = isLocalFoodId(currentFood.id);
  const displayName =
    (i18n.language === 'en' ? currentFood.nameEn : currentFood.nameHu) ??
    currentFood.displayName ??
    currentFood.name;
  const brandLabel = distinctBrand(displayName, currentFood.brand);

  const foodUnit = normalizeServingUnit(currentFood.servingUnit);
  const gramsPerUnit = gramsPerServingUnit(currentFood);
  const unitLabel = (u: ServingUnitCode) => {
    if (u === 'g') return t('food.unitG');
    if (u === 'db') return t('food.unitDb');
    if (u === 'adag') return t('food.unitAdag');
    if (u === 'ek') return t('food.unitEk');
    return t('food.unitSzelet');
  };
  const portionLabel =
    foodUnit === 'g'
      ? t('food.portionBadgeGrams', { grams: Math.round(gramsPerUnit) })
      : t('food.portionBadgeUnit', {
          unit: unitLabel(foodUnit),
          grams: Math.round(gramsPerUnit * 10) / 10,
        });

  const qty = parseFloat(amount.replace(',', '.')) || 0;
  const g = qtyToGrams(qty, displayUnit, gramsPerUnit);
  const calc = {
    kcal: Math.round((currentFood.kcal / 100) * g),
    protein: Math.round((currentFood.protein / 100) * g * 10) / 10,
    carbs: Math.round((currentFood.carbs / 100) * g * 10) / 10,
    fat: Math.round((currentFood.fat / 100) * g * 10) / 10,
    sugar:
      currentFood.sugar != null ? Math.round((currentFood.sugar / 100) * g * 10) / 10 : null,
    fiber:
      currentFood.fiber != null ? Math.round((currentFood.fiber / 100) * g * 10) / 10 : null,
  };

  const totalMacro = Math.max(0.1, currentFood.carbs + currentFood.protein + currentFood.fat);
  const carbsPct = (currentFood.carbs / totalMacro) * 100;
  const proteinPct = (currentFood.protein / totalMacro) * 100;
  const fatPct = (currentFood.fat / totalMacro) * 100;

  const mealLabel = (m: MealType) => {
    if (m === 'BREAKFAST') return t('food.breakfast');
    if (m === 'TIZORAI') return t('food.tizorai');
    if (m === 'LUNCH') return t('food.lunch');
    if (m === 'UZSONNA') return t('food.uzsonna');
    if (m === 'DINNER') return t('food.dinner');
    return t('food.snack');
  };

  const formatQty = (n: number) =>
    String(Number.isInteger(n) ? n : Math.round(n * 10) / 10);

  const switchDisplayUnit = (next: ServingUnitCode) => {
    if (next === displayUnit) return;
    const grams = qtyToGrams(qty, displayUnit, gramsPerUnit);
    if (next === 'g') {
      setAmount(formatQty(Math.max(1, Math.round(grams))));
    } else {
      const pieces = gramsPerUnit > 0 ? grams / gramsPerUnit : 1;
      setAmount(formatQty(Math.max(0.1, Math.round(pieces * 10) / 10)));
    }
    setDisplayUnit(next);
  };

  /** Grams: ±10; piece/adag/ek: ±1 */
  const adjustAmount = (dir: -1 | 1) => {
    if (displayUnit === 'g') {
      setAmount(String(Math.max(0, Math.round(qty + dir * 10))));
      return;
    }
    const next = Math.max(0, Math.round((qty + dir * 1) * 10) / 10);
    setAmount(formatQty(next));
  };

  const handleAddLog = async () => {
    if (!g || g <= 0) {
      window.alert(t('food.enterAmount'));
      return;
    }
    setAdding(true);
    try {
      if (intent === 'pantry') {
        const unit: 'g' | 'ml' | 'db' = displayUnit === 'db' ? 'db' : 'g';
        const quantity = unit === 'db' ? qty : g;
        await pantryApi.add({
          ownerId: pantryOwnerId,
          foodId: isLocalFoodId(currentFood.id) ? currentFood.id : undefined,
          name: displayName,
          quantity,
          unit,
          source: 'BARCODE',
        });
        onPantryAdded?.();
        return;
      }
      await confirmIfActive();
      const isUuid =
        typeof currentFood.id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          currentFood.id,
        );
      const components = currentFood.components ?? [];
      const isPrepared = currentFood.isPrepared && components.length > 0;
      const recipeG = preparedRecipeGrams(components);
      const scale = g / recipeG;

      if (isPrepared && showIngredients) {
        const logGroupId = crypto.randomUUID();
        for (const c of components) {
          await logApi.create({
            foodName: c.name,
            kcal: Math.round(c.kcal * scale * 10) / 10,
            protein: Math.round(c.protein * scale * 10) / 10,
            carbs: Math.round(c.carbs * scale * 10) / 10,
            fat: Math.round(c.fat * scale * 10) / 10,
            fiber: c.fiber != null ? Math.round(c.fiber * scale * 10) / 10 : undefined,
            sugar: c.sugar != null ? Math.round(c.sugar * scale * 10) / 10 : undefined,
            amount: Math.max(1, Math.round(c.amountG * scale * 10) / 10),
            mealType,
            source: logSource,
            date: toLocalDateStr(selectedDate),
            logGroupId,
            logGroupName: displayName,
            sourcePreparedFoodId: isUuid ? currentFood.id : undefined,
          });
        }
      } else {
        await logApi.create({
          ...(isUuid ? { foodId: currentFood.id } : {}),
          foodName: displayName,
          kcal: calc.kcal,
          protein: calc.protein,
          carbs: calc.carbs,
          fat: calc.fat,
          fiber: calc.fiber ?? undefined,
          sugar: calc.sugar ?? undefined,
          amount: g,
          mealType,
          source: logSource,
          date: toLocalDateStr(selectedDate),
          sourcePreparedFoodId: isPrepared && isUuid ? currentFood.id : undefined,
        });
      }
      onLogAdded?.();
      onClose();
    } catch (e: any) {
      window.alert(e?.message || t('food.errorTitle'));
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteFood = async () => {
    if (!currentFood || !isLocalFoodId(currentFood.id)) return;
    setDeletingFood(true);
    try {
      await adminApi.deleteFood(currentFood.id);
      onFoodDeleted?.(currentFood.id);
      onClose();
    } catch (e: any) {
      window.alert(e?.message || t('food.errorTitle'));
    } finally {
      setDeletingFood(false);
      setConfirmDeleteFood(false);
    }
  };

  const canDeleteFood = isAdmin && isLocalFoodId(currentFood.id);

  return createPortal(
    <div className={styles.detailScreen}>
      <header className={styles.detailHeader}>
        <button type="button" className={styles.backBtn} onClick={onClose}>
          <span className={styles.backBtnShadow} />
          <span className={styles.backBtnInner}>
            <IconArrowBack size={24} color={Colors.dashboard.stroke} />
          </span>
        </button>
        <h2 className={styles.detailTitle}>{t('food.productDetailsTitle')}</h2>
        {canEditFood || canDeleteFood ? (
          <div className={styles.headerActions}>
            {canDeleteFood ? (
              <button
                type="button"
                className={styles.headerEditBtn}
                aria-label={t('common.delete', 'Törlés')}
                disabled={deletingFood}
                onClick={() => setConfirmDeleteFood(true)}
              >
                <span className={styles.headerEditShadow} />
                <span className={`${styles.headerEditInner} ${styles.headerDeleteInner}`}>
                  <IconDelete size={20} color="#B83B3B" />
                </span>
              </button>
            ) : null}
            {canEditFood ? (
              <button
                type="button"
                className={styles.headerEditBtn}
                aria-label={t('food.editFood')}
                onClick={() => setEditOpen(true)}
              >
                <span className={styles.headerEditShadow} />
                <span className={styles.headerEditInner}>
                  <IconEdit size={20} color={Colors.dashboard.stroke} />
                </span>
              </button>
            ) : null}
          </div>
        ) : (
          <span className={styles.headerSpacer} />
        )}
      </header>

      <div className={styles.detailBody}>
        <div className={styles.productCard}>
          <span className={styles.productShadow} />
          <div className={styles.productInner}>
            <span className={styles.productDecorLeft}>
              <IconApple size={80} color={Colors.dashboard.stroke} style={{ opacity: 0.1 }} />
            </span>
            <span className={styles.productDecorRight}>
              <IconLeaf size={32} color={Colors.dashboard.nutritionIcon} style={{ opacity: 0.3 }} />
            </span>
            <h3 className={foodNameSizeClass(displayName)}>{displayName}</h3>
            {brandLabel ? <p className={styles.foodBrand}>{brandLabel}</p> : null}
            <div className={styles.portionBadgeWrap}>
              <span className={styles.portionBadgeShadow} />
              <span className={styles.portionBadgeInner}>
                <span className={styles.portionText}>{portionLabel}</span>
              </span>
            </div>
          </div>
        </div>

        {currentFood.isPrepared && (currentFood.components?.length ?? 0) > 0 && (
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
        )}

        {currentFood.isPrepared &&
          showIngredients &&
          (currentFood.components?.length ?? 0) > 0 && (
          <div className={styles.componentsCard}>
            <div className={styles.sectionTitle}>{t('food.preparedIngredients')}</div>
            {(currentFood.components ?? []).map((c, i) => {
              const scale = g / preparedRecipeGrams(currentFood.components ?? []);
              return (
                <div key={c.id ?? `${c.name}-${i}`} className={styles.componentRow}>
                  <div className={styles.componentName}>{c.name}</div>
                  <div className={styles.componentMeta}>
                    {Math.round(c.amountG * scale)}g · {Math.round(c.kcal * scale)} kcal · F{' '}
                    {Math.round(c.protein * scale * 10) / 10} · Sz{' '}
                    {Math.round(c.carbs * scale * 10) / 10} · Zs{' '}
                    {Math.round(c.fat * scale * 10) / 10}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.sections}>
          <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
            <div className={styles.amountStepper}>
              <button type="button" className={styles.amountStepBtn} onClick={() => adjustAmount(-1)}>
                <span className={styles.amountStepShadow} />
                <span className={styles.amountStepFace}>
                  <IconRemove size={22} color={Colors.dashboard.stroke} />
                </span>
              </button>
              <div className={styles.amountCenter}>
                <input
                  className={styles.amountInputCompact}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
                  inputMode="decimal"
                  placeholder={displayUnit === 'g' ? '100' : '1'}
                />
                <span className={styles.amountUnit}>{unitLabel(displayUnit)}</span>
              </div>
              <button type="button" className={styles.amountStepBtn} onClick={() => adjustAmount(1)}>
                <span className={styles.amountStepShadow} />
                <span className={styles.amountStepFace}>
                  <IconAdd size={22} color={Colors.dashboard.stroke} />
                </span>
              </button>
            </div>
            {foodUnit !== 'g' ? (
              <div className={styles.unitSegment} role="group" aria-label={t('food.servingUnit')}>
                <button
                  type="button"
                  className={`${styles.unitSegmentBtn} ${displayUnit === foodUnit ? styles.unitSegmentBtnActive : ''}`}
                  onClick={() => switchDisplayUnit(foodUnit)}
                >
                  {unitLabel(foodUnit)}
                </button>
                <button
                  type="button"
                  className={`${styles.unitSegmentBtn} ${displayUnit === 'g' ? styles.unitSegmentBtnActive : ''}`}
                  onClick={() => switchDisplayUnit('g')}
                >
                  {t('food.unitG')}
                </button>
              </div>
            ) : null}
            {displayUnit !== 'g' ? (
              <div className={styles.amountMetaRow}>
                <span className={styles.amountMetaLabel}>{t('food.amount')}</span>
                <span className={styles.amountMetaValue}>
                  {t('food.amountEqualsGrams', { grams: Math.round(g * 10) / 10 })}
                </span>
              </div>
            ) : null}
          </GlassCardSimple>

          <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
            <div className={styles.sectionHeaderSmall}>
              <SectionIcon background={Colors.dashboard.blobMint}>
                <IconPieChartOutline size={20} color={Colors.dashboard.stroke} />
              </SectionIcon>
              <span className={styles.sectionTitle}>Makrotápanyagok</span>
            </div>
            <div className={styles.macroEnergyRow}>
              <div className={styles.energyLeft}>
                <IconBolt size={20} color={Colors.dashboard.nutritionIcon} />
                <span className={styles.energyLabel}>{t('food.energy').toUpperCase()}</span>
              </div>
              <span className={styles.energyValue}>{calc.kcal} kcal</span>
            </div>
            <div className={styles.macroBars}>
              <MacroBar
                label={t('food.protein')}
                grams={calc.protein}
                percent={proteinPct}
                color={Colors.dashboard.proteinFill}
                rotation={0.5}
              />
              <MacroBar
                label={t('food.carbs')}
                grams={calc.carbs}
                percent={carbsPct}
                color={Colors.dashboard.carbsFill}
                rotation={-0.5}
                sugarNote={
                  calc.sugar != null
                    ? `${t('food.ofWhichSugar')}: ${calc.sugar}g`
                    : undefined
                }
              />
              <MacroBar
                label={t('food.fat')}
                grams={calc.fat}
                percent={fatPct}
                color={Colors.dashboard.fatFill}
                rotation={-0.5}
              />
            </div>
            {calc.fiber != null && (
              <div className={styles.extraNutri}>
                <div className={styles.nutrRow}>
                  <span className={styles.nutrDot} style={{ background: Colors.macro.fiber }} />
                  <span className={styles.nutrLabel}>{t('food.fiber')}</span>
                  <span className={styles.nutrValue} style={{ color: Colors.macro.fiber }}>
                    {calc.fiber}g
                  </span>
                </div>
              </div>
            )}
          </GlassCardSimple>

          {intent === 'log' ? (
          <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
            <div className={styles.sectionHeaderSmall}>
              <SectionIcon background={Colors.dashboard.blobPeach}>
                <IconRestaurantOutline size={20} color={Colors.dashboard.stroke} />
              </SectionIcon>
              <span className={styles.sectionTitle}>{t('food.mealType')}</span>
            </div>
            <div className={styles.mealRow}>
              {MEAL_TYPES.map((m) => {
                const active = mealType === m;
                return (
                  <button
                    key={m}
                    type="button"
                    className={styles.mealBtnWrap}
                    onClick={() => setMealType(m)}
                  >
                    {active && <span className={styles.mealBtnShadow} />}
                    <span className={`${styles.mealBtnInner} ${active ? styles.mealBtnInnerActive : ''}`}>
                      <span className={`${styles.mealBtnText} ${active ? styles.mealBtnTextActive : ''}`}>
                        {mealLabel(m)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </GlassCardSimple>
          ) : null}

          {canEditFood && (
            <>
              <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
                <VoteButtons
                  food={currentFood}
                  onVoted={(score, myVote, status) =>
                    setCurrentFood((f) => (f ? { ...f, score, myVote, ...(status ? { status } : {}) } : f))
                  }
                />
              </GlassCardSimple>
              <EditHistoryCard key={`${currentFood.id}-${historyKey}`} foodId={currentFood.id} />
            </>
          )}

          <div className={styles.scrollSpacer} />
        </div>
      </div>

      <footer className={styles.detailFooter}>
        <button type="button" className={styles.addBtnWrap} onClick={handleAddLog} disabled={adding}>
          <span className={styles.addBtnShadow} />
          <span className={styles.addBtnInner}>
            <IconAddCircle size={24} color="#fff" />
            <span className={styles.addBtnLabel}>
              {adding
                ? t('common.loading', 'Betöltés...')
                : intent === 'pantry'
                  ? t('mealPlan.addToPantry')
                  : t('food.addToLog')}
            </span>
          </span>
        </button>
      </footer>

      <ConfirmDialog
        visible={confirmDeleteFood}
        title={t('food.confirmDeleteFoodTitle')}
        message={t('food.confirmDeleteFood')}
        confirmLabel={t('common.delete', 'Törlés')}
        cancelLabel={t('common.cancel', 'Mégse')}
        destructive
        onConfirm={() => {
          void handleDeleteFood();
        }}
        onClose={() => setConfirmDeleteFood(false)}
      />
      {fastingDialog}

      <EditFoodModal
        visible={editOpen}
        food={currentFood}
        onClose={() => setEditOpen(false)}
        onUpdated={(updated) => {
          setCurrentFood((prev) => ({
            ...(prev ?? {}),
            ...updated,
            displayName: updated.nameHu ?? updated.nameEn ?? updated.name,
            origin: prev?.origin ?? updated.origin,
            isFavorite: prev?.isFavorite ?? updated.isFavorite,
            score: prev?.score,
            myVote: prev?.myVote,
          }));
          setEditOpen(false);
          setHistoryKey((k) => k + 1);
        }}
      />
    </div>,
    document.body,
  );
}

export type DailyLogItem = {
  id: string;
  foodName: string;
  brand?: string | null;
  amount: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number | null;
  sugar?: number | null;
  mealType: MealType | string;
  logGroupId?: string | null;
  logGroupName?: string | null;
  sourcePreparedFoodId?: string | null;
  sourcePreparedFoodName?: string | null;
  foodId?: string | null;
  servingSize?: number | null;
  servingUnit?: string | null;
};

type GroupIngDraft = {
  id: string;
  name: string;
  amount: string;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  sugar: string;
};

function parseQty(v: string): number {
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function formatDraftQty(n: number): string {
  return String(Number.isInteger(n) ? n : Math.round(n * 10) / 10);
}

function logToGroupDraft(log: DailyLogItem): GroupIngDraft {
  return {
    id: log.id,
    name: log.foodName,
    amount: formatDraftQty(log.amount),
    kcal: formatDraftQty(log.kcal),
    protein: formatDraftQty(log.protein),
    carbs: formatDraftQty(log.carbs),
    fat: formatDraftQty(log.fat),
    fiber: log.fiber != null ? formatDraftQty(log.fiber) : '',
    sugar: log.sugar != null ? formatDraftQty(log.sugar) : '',
  };
}

function scaleGroupDraft(ing: GroupIngDraft, ratio: number): GroupIngDraft {
  const mul = (s: string) => (s.trim() ? formatDraftQty(parseQty(s) * ratio) : '');
  return {
    ...ing,
    amount: formatDraftQty(Math.max(0, parseQty(ing.amount) * ratio)),
    kcal: mul(ing.kcal),
    protein: mul(ing.protein),
    carbs: mul(ing.carbs),
    fat: mul(ing.fat),
    fiber: mul(ing.fiber),
    sugar: mul(ing.sugar),
  };
}

type RecipeCompDraft = {
  key: string;
  name: string;
  amountG: string;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
};

function scaleRecipeComp(row: RecipeCompDraft, ratio: number): RecipeCompDraft {
  const mul = (s: string) => (s.trim() ? formatDraftQty(parseQty(s) * ratio) : '');
  return {
    ...row,
    amountG: formatDraftQty(Math.max(0, parseQty(row.amountG) * ratio)),
    kcal: mul(row.kcal),
    protein: mul(row.protein),
    carbs: mul(row.carbs),
    fat: mul(row.fat),
  };
}

interface EditLogModalProps {
  log: DailyLogItem | null;
  groupLogs?: DailyLogItem[] | null;
  visible: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function EditLogModal({ log, groupLogs, visible, onClose, onSaved }: EditLogModalProps) {
  const { t } = useTranslation();
  const selectedDate = useDateStore((s) => s.selectedDate);
  const [amount, setAmount] = useState('100');
  const [displayUnit, setDisplayUnit] = useState<ServingUnitCode>('g');
  const [mealType, setMealType] = useState<MealType>('SNACK');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [base, setBase] = useState<DailyLogItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string } | null>(null);
  const [editFood, setEditFood] = useState<Food | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [showIngredients, setShowIngredients] = useState(false);
  const [preparedFood, setPreparedFood] = useState<Food | null>(null);
  const [groupIngs, setGroupIngs] = useState<GroupIngDraft[]>([]);
  const groupOrigRef = useRef<GroupIngDraft[]>([]);
  const groupOrigTotalRef = useRef(1);

  useEffect(() => {
    if (!visible) return;
    if (groupLogs && groupLogs.length > 1) {
      const drafts = groupLogs.map(logToGroupDraft);
      const total = drafts.reduce((s, d) => s + parseQty(d.amount), 0);
      groupOrigRef.current = drafts;
      groupOrigTotalRef.current = total || 1;
      setGroupIngs(drafts);
      const first = groupLogs[0]!;
      setBase({
        ...first,
        foodName: first.logGroupName || first.sourcePreparedFoodName || first.foodName,
        amount: total || 1,
        kcal: groupLogs.reduce((s, l) => s + l.kcal, 0),
        protein: groupLogs.reduce((s, l) => s + l.protein, 0),
        carbs: groupLogs.reduce((s, l) => s + l.carbs, 0),
        fat: groupLogs.reduce((s, l) => s + l.fat, 0),
        fiber: groupLogs.reduce((s, l) => s + (l.fiber ?? 0), 0),
        sugar: groupLogs.reduce((s, l) => s + (l.sugar ?? 0), 0),
      });
      setDisplayUnit('g');
      setAmount(formatDraftQty(total || 1));
      setMealType((first.mealType as MealType) || 'SNACK');
      setConfirmDelete(false);
      setDialog(null);
      setEditOpen(false);
      setEditFood(null);
      setShowIngredients(true);
      setPreparedFood(null);
      return;
    }
    if (log) {
      setGroupIngs([]);
      groupOrigRef.current = [];
      setBase(log);
      const unit = normalizeServingUnit(log.servingUnit);
      const gpu =
        log.servingSize != null && log.servingSize > 0 ? log.servingSize : 100;
      setDisplayUnit(unit);
      const grams = log.amount > 0 ? log.amount : 100;
      if (unit === 'g') {
        setAmount(String(Math.round(grams * 10) / 10));
      } else {
        const pieces = gpu > 0 ? grams / gpu : 1;
        setAmount(String(Number.isInteger(pieces) ? pieces : Math.round(pieces * 10) / 10));
      }
      setMealType((log.mealType as MealType) || 'SNACK');
      setConfirmDelete(false);
      setDialog(null);
      setEditOpen(false);
      setEditFood(null);
      setShowIngredients(false);
      setPreparedFood(null);
    }
  }, [visible, log, groupLogs]);

  useEffect(() => {
    if (!visible) return;
    const editingGroup = !!(groupLogs && groupLogs.length > 1);
    const row = editingGroup ? groupLogs[0] : log;
    if (!row) return;
    const parentPreparedId = isLocalFoodId(row.sourcePreparedFoodId)
      ? row.sourcePreparedFoodId
      : undefined;
    const ownFoodId = isLocalFoodId(row.foodId) ? row.foodId : undefined;
    // Nested group members inherit the parent dish's sourcePreparedFoodId.
    // That is grouping metadata, not this row's own recipe — only foodId may
    // unlock further breakdown, and only if it is a different prepared food.
    const isNestedMember = !editingGroup && !!row.logGroupId;
    const ids = [...new Set(
      (isNestedMember
        ? [ownFoodId && ownFoodId !== parentPreparedId ? ownFoodId : undefined]
        : [ownFoodId, parentPreparedId]
      ).filter((id): id is string => !!id),
    )];
    if (!ids.length) return;
    let cancelled = false;
    Promise.all(ids.map((id) => foodApi.getById(id).catch(() => null)))
      .then((foods) => {
        if (cancelled) return;
        const match = foods.find((f) => f?.isPrepared && (f.components?.length ?? 0) > 0);
        if (match) setPreparedFood(match);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, log, groupLogs]);

  if (!visible || !base) return null;

  const isGroup = groupIngs.length > 1;
  const preparedComponents = preparedFood?.components ?? [];
  const hasPreparedIngredients =
    !isGroup && !!preparedFood?.isPrepared && preparedComponents.length > 0;
  const canToggleIngredients = isGroup || hasPreparedIngredients;
  const recipeG = preparedRecipeGrams(preparedComponents);

  const baseAmount = base.amount > 0 ? base.amount : 100;
  const brandLabel = distinctBrand(base.foodName, base.brand);
  const foodUnit = normalizeServingUnit(base.servingUnit);
  const gramsPerUnit =
    base.servingSize != null && base.servingSize > 0 ? base.servingSize : 100;

  const unitLabel = (u: ServingUnitCode) => {
    if (u === 'g') return t('food.unitG');
    if (u === 'db') return t('food.unitDb');
    if (u === 'adag') return t('food.unitAdag');
    if (u === 'ek') return t('food.unitEk');
    return t('food.unitSzelet');
  };

  const portionLabel =
    foodUnit === 'g'
      ? t('food.portionBadgeGrams', { grams: Math.round(gramsPerUnit) })
      : t('food.portionBadgeUnit', {
          unit: unitLabel(foodUnit),
          grams: Math.round(gramsPerUnit * 10) / 10,
        });

  const formatQty = (n: number) =>
    String(Number.isInteger(n) ? n : Math.round(n * 10) / 10);

  const qty = parseFloat(amount.replace(',', '.')) || 0;
  const g = isGroup ? qty : qtyToGrams(qty, displayUnit, gramsPerUnit);
  const ratio = g / baseAmount;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const groupTotals = groupIngs.reduce(
    (acc, ing) => ({
      kcal: acc.kcal + parseQty(ing.kcal),
      protein: acc.protein + parseQty(ing.protein),
      carbs: acc.carbs + parseQty(ing.carbs),
      fat: acc.fat + parseQty(ing.fat),
      sugar: acc.sugar + parseQty(ing.sugar),
      fiber: acc.fiber + parseQty(ing.fiber),
      amount: acc.amount + parseQty(ing.amount),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0, amount: 0 },
  );
  const calc = isGroup
    ? {
        kcal: Math.round(groupTotals.kcal),
        protein: round1(groupTotals.protein),
        carbs: round1(groupTotals.carbs),
        fat: round1(groupTotals.fat),
        sugar: groupTotals.sugar > 0 ? round1(groupTotals.sugar) : null,
        fiber: groupTotals.fiber > 0 ? round1(groupTotals.fiber) : null,
      }
    : {
        kcal: Math.round(base.kcal * ratio),
        protein: round1(base.protein * ratio),
        carbs: round1(base.carbs * ratio),
        fat: round1(base.fat * ratio),
        sugar: base.sugar != null ? round1(base.sugar * ratio) : null,
        fiber: base.fiber != null ? round1(base.fiber * ratio) : null,
      };

  const per100 = {
    protein: (base.protein / baseAmount) * 100,
    carbs: (base.carbs / baseAmount) * 100,
    fat: (base.fat / baseAmount) * 100,
    sugar: base.sugar != null ? (base.sugar / baseAmount) * 100 : null,
    fiber: base.fiber != null ? (base.fiber / baseAmount) * 100 : null,
  };
  const totalMacro = isGroup
    ? Math.max(0.1, calc.carbs + calc.protein + calc.fat)
    : Math.max(0.1, per100.carbs + per100.protein + per100.fat);
  const carbsPct = (isGroup ? calc.carbs : per100.carbs) / totalMacro * 100;
  const proteinPct = (isGroup ? calc.protein : per100.protein) / totalMacro * 100;
  const fatPct = (isGroup ? calc.fat : per100.fat) / totalMacro * 100;

  const mealLabel = (m: MealType) => {
    if (m === 'BREAKFAST') return t('food.breakfast');
    if (m === 'TIZORAI') return t('food.tizorai');
    if (m === 'LUNCH') return t('food.lunch');
    if (m === 'UZSONNA') return t('food.uzsonna');
    if (m === 'DINNER') return t('food.dinner');
    return t('food.snack');
  };

  const switchDisplayUnit = (next: ServingUnitCode) => {
    if (next === displayUnit) return;
    const grams = qtyToGrams(qty, displayUnit, gramsPerUnit);
    if (next === 'g') {
      setAmount(formatQty(Math.max(1, Math.round(grams))));
    } else {
      const pieces = gramsPerUnit > 0 ? grams / gramsPerUnit : 1;
      setAmount(formatQty(Math.max(0.1, Math.round(pieces * 10) / 10)));
    }
    setDisplayUnit(next);
  };

  const commitGroupTotal = (newTotal: number) => {
    const currentTotal = groupIngs.reduce((s, i) => s + parseQty(i.amount), 0) || 1;
    const r = Math.max(0, newTotal) / currentTotal;
    const next = groupIngs.map((ing) => scaleGroupDraft(ing, r));
    groupOrigRef.current = next;
    groupOrigTotalRef.current = Math.max(0, newTotal) || 1;
    setGroupIngs(next);
    setAmount(formatQty(Math.max(0, newTotal)));
  };

  const adjustAmount = (dir: -1 | 1) => {
    if (isGroup) {
      commitGroupTotal(Math.max(0, Math.round(qty + dir * 10)));
      return;
    }
    if (displayUnit === 'g') {
      setAmount(String(Math.max(0, Math.round(qty + dir * 10))));
      return;
    }
    const next = Math.max(0, Math.round((qty + dir * 1) * 10) / 10);
    setAmount(formatQty(next));
  };

  const handleSave = async () => {
    if (!g || g <= 0) {
      setDialog({ title: t('food.errorTitle'), message: t('food.enterAmount') });
      return;
    }
    setSaving(true);
    try {
      if (isGroup && !showIngredients) {
        const currentTotal = groupIngs.reduce((s, i) => s + parseQty(i.amount), 0) || 1;
        const ratio = qty / currentTotal;
        const toSave =
          Math.abs(ratio - 1) < 0.001
            ? groupIngs
            : groupIngs.map((ing) => scaleGroupDraft(ing, ratio));
        const totals = toSave.reduce(
          (acc, ing) => ({
            amount: acc.amount + Math.max(1, parseQty(ing.amount)),
            kcal: acc.kcal + Math.max(0, parseQty(ing.kcal)),
            protein: acc.protein + Math.max(0, parseQty(ing.protein)),
            carbs: acc.carbs + Math.max(0, parseQty(ing.carbs)),
            fat: acc.fat + Math.max(0, parseQty(ing.fat)),
            fiber: acc.fiber + (ing.fiber.trim() ? Math.max(0, parseQty(ing.fiber)) : 0),
            sugar: acc.sugar + (ing.sugar.trim() ? Math.max(0, parseQty(ing.sugar)) : 0),
          }),
          { amount: 0, kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 },
        );
        const preparedId = isLocalFoodId(base.sourcePreparedFoodId)
          ? base.sourcePreparedFoodId
          : isLocalFoodId(base.foodId)
            ? base.foodId
            : undefined;
        await logApi.create({
          foodName: base.foodName.trim() || t('food.foodName'),
          kcal: Math.round(totals.kcal * 10) / 10,
          protein: Math.round(totals.protein * 10) / 10,
          carbs: Math.round(totals.carbs * 10) / 10,
          fat: Math.round(totals.fat * 10) / 10,
          fiber: totals.fiber > 0 ? Math.round(totals.fiber * 10) / 10 : undefined,
          sugar: totals.sugar > 0 ? Math.round(totals.sugar * 10) / 10 : undefined,
          amount: Math.max(1, Math.round(totals.amount * 10) / 10),
          mealType,
          source: 'MANUAL',
          date: toLocalDateStr(selectedDate),
          ...(preparedId ? { foodId: preparedId, sourcePreparedFoodId: preparedId } : {}),
        });
        if (base.logGroupId) await logApi.deleteGroup(base.logGroupId);
      } else if (isGroup) {
        const currentTotal = groupIngs.reduce((s, i) => s + parseQty(i.amount), 0) || 1;
        const ratio = qty / currentTotal;
        const toSave =
          Math.abs(ratio - 1) < 0.001
            ? groupIngs
            : groupIngs.map((ing) => scaleGroupDraft(ing, ratio));
        for (const ing of toSave) {
          const amt = Math.max(1, parseQty(ing.amount));
          await logApi.update(ing.id, {
            foodName: ing.name.trim() || t('food.ingredientName'),
            amount: amt,
            kcal: Math.max(0, parseQty(ing.kcal)),
            protein: Math.max(0, parseQty(ing.protein)),
            carbs: Math.max(0, parseQty(ing.carbs)),
            fat: Math.max(0, parseQty(ing.fat)),
            fiber: ing.fiber.trim() ? Math.max(0, parseQty(ing.fiber)) : null,
            sugar: ing.sugar.trim() ? Math.max(0, parseQty(ing.sugar)) : null,
            mealType,
          });
        }
      } else if (hasPreparedIngredients && showIngredients) {
        const scale = g / recipeG;
        const logGroupId = crypto.randomUUID();
        const date = toLocalDateStr(selectedDate);
        const preparedId = preparedFood!.id;
        const groupName =
          preparedFood?.nameHu || preparedFood?.nameEn || preparedFood?.name || base.foodName;
        for (const c of preparedComponents) {
          await logApi.create({
            foodName: c.name,
            kcal: Math.round(c.kcal * scale * 10) / 10,
            protein: Math.round(c.protein * scale * 10) / 10,
            carbs: Math.round(c.carbs * scale * 10) / 10,
            fat: Math.round(c.fat * scale * 10) / 10,
            fiber: c.fiber != null ? Math.round(c.fiber * scale * 10) / 10 : undefined,
            sugar: c.sugar != null ? Math.round(c.sugar * scale * 10) / 10 : undefined,
            amount: Math.max(1, Math.round(c.amountG * scale * 10) / 10),
            mealType,
            source: 'MANUAL',
            date,
            logGroupId,
            logGroupName: groupName,
            sourcePreparedFoodId: preparedId,
          });
        }
        await logApi.delete(base.id);
      } else {
        await logApi.update(base.id, { amount: g, mealType });
      }
      onSaved?.();
      onClose();
    } catch (e: any) {
      setDialog({ title: t('food.errorTitle'), message: e?.message || t('food.errorTitle') });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      if (isGroup && base.logGroupId) {
        await logApi.deleteGroup(base.logGroupId);
      } else {
        await logApi.delete(base.id);
      }
      onSaved?.();
      onClose();
    } catch (e: any) {
      setDialog({ title: t('food.errorTitle'), message: e?.message || t('food.errorTitle') });
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || deleting || editLoading;
  const canEditLinkedFood = !isGroup && isLocalFoodId(base.foodId);

  const openFoodEdit = async () => {
    if (!base.foodId || !isLocalFoodId(base.foodId)) return;
    setEditLoading(true);
    try {
      const food = await foodApi.getById(base.foodId);
      setEditFood(food);
      setEditOpen(true);
    } catch (e: any) {
      setDialog({ title: t('food.errorTitle'), message: e?.message || t('food.errorTitle') });
    } finally {
      setEditLoading(false);
    }
  };

  return createPortal(
    <div className={styles.detailScreen}>
      <header className={styles.detailHeader}>
        <button type="button" className={styles.backBtn} onClick={onClose}>
          <span className={styles.backBtnShadow} />
          <span className={styles.backBtnInner}>
            <IconArrowBack size={24} color={Colors.dashboard.stroke} />
          </span>
        </button>
        <h2 className={styles.detailTitle}>{t('food.editLogTitle', 'Bejegyzés szerkesztése')}</h2>
        {canEditLinkedFood ? (
          <button
            type="button"
            className={styles.headerEditBtn}
            aria-label={t('food.editFood')}
            disabled={editLoading}
            onClick={() => {
              void openFoodEdit();
            }}
          >
            <span className={styles.headerEditShadow} />
            <span className={styles.headerEditInner}>
              <IconEdit size={20} color={Colors.dashboard.stroke} />
            </span>
          </button>
        ) : (
          <span className={styles.headerSpacer} />
        )}
      </header>

      <div className={styles.detailBody}>
        <div className={styles.productCard}>
          <span className={styles.productShadow} />
          <div className={styles.productInner}>
            <span className={styles.productDecorLeft}>
              <IconApple size={80} color={Colors.dashboard.stroke} style={{ opacity: 0.1 }} />
            </span>
            <span className={styles.productDecorRight}>
              <IconLeaf size={32} color={Colors.dashboard.nutritionIcon} style={{ opacity: 0.3 }} />
            </span>
            <h3 className={foodNameSizeClass(base.foodName)}>{base.foodName}</h3>
            {brandLabel ? <p className={styles.foodBrand}>{brandLabel}</p> : null}
            {!isGroup ? (
              <div className={styles.portionBadgeWrap}>
                <span className={styles.portionBadgeShadow} />
                <span className={styles.portionBadgeInner}>
                  <span className={styles.portionText}>{portionLabel}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {canToggleIngredients && (
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
        )}

        {isGroup && showIngredients && (
          <div className={styles.componentsCard}>
            <div className={styles.sectionTitle}>{t('food.preparedIngredients')}</div>
            <p className={styles.recipeHint}>{t('food.editLogDiaryHint')}</p>
            {groupIngs.map((ing, index) => (
              <div key={ing.id} className={styles.recipeCard}>
                <div className={styles.recipeCardHead}>
                  <span className={styles.recipeIndex}>{index + 1}</span>
                  <input
                    className={styles.formInput}
                    value={ing.name}
                    placeholder={t('food.ingredientName')}
                    onChange={(e) => {
                      const name = e.target.value;
                      setGroupIngs((prev) =>
                        prev.map((row) => (row.id === ing.id ? { ...row, name } : row)),
                      );
                    }}
                  />
                </div>
                <div className={styles.recipeGrid}>
                  {(
                    [
                      { field: 'amount', label: t('food.ingredientAmountG') },
                      { field: 'kcal', label: 'kcal' },
                      { field: 'protein', label: t('food.protein') },
                      { field: 'carbs', label: t('food.carbs') },
                      { field: 'fat', label: t('food.fat') },
                    ] as const
                  ).map(({ field, label }) => (
                    <label key={field} className={styles.recipeField}>
                      <span>{label}</span>
                      <input
                        className={styles.formInput}
                        inputMode="decimal"
                        value={ing[field]}
                        onChange={(e) => {
                          const raw = e.target.value.replace(/[^\d.,]/g, '');
                          setGroupIngs((prev) =>
                            prev.map((row) => {
                              if (row.id !== ing.id) return row;
                              if (field !== 'amount') return { ...row, [field]: raw };
                              const orig = groupOrigRef.current.find((o) => o.id === ing.id);
                              const origAmt = orig ? parseQty(orig.amount) : 0;
                              const newAmt = parseQty(raw);
                              if (!orig || origAmt <= 0) return { ...row, amount: raw };
                              return { ...scaleGroupDraft(orig, newAmt / origAmt), name: row.name };
                            }),
                          );
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {hasPreparedIngredients && showIngredients && (
          <div className={styles.componentsCard}>
            <div className={styles.sectionTitle}>{t('food.preparedIngredients')}</div>
            {preparedComponents.map((c, i) => {
              const scale = g / recipeG;
              return (
                <div key={c.id ?? `${c.name}-${i}`} className={styles.componentRow}>
                  <div className={styles.componentName}>{c.name}</div>
                  <div className={styles.componentMeta}>
                    {Math.round(c.amountG * scale)}g · {Math.round(c.kcal * scale)} kcal · F{' '}
                    {Math.round(c.protein * scale * 10) / 10} · Sz{' '}
                    {Math.round(c.carbs * scale * 10) / 10} · Zs{' '}
                    {Math.round(c.fat * scale * 10) / 10}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.sections}>
          <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
            <div className={styles.amountStepper}>
              <button type="button" className={styles.amountStepBtn} onClick={() => adjustAmount(-1)}>
                <span className={styles.amountStepShadow} />
                <span className={styles.amountStepFace}>
                  <IconRemove size={22} color={Colors.dashboard.stroke} />
                </span>
              </button>
              <div className={styles.amountCenter}>
                <input
                  className={styles.amountInputCompact}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
                  onBlur={() => {
                    if (isGroup) commitGroupTotal(qty);
                  }}
                  inputMode="decimal"
                  placeholder={displayUnit === 'g' ? '100' : '1'}
                />
                <span className={styles.amountUnit}>{unitLabel(displayUnit)}</span>
              </div>
              <button type="button" className={styles.amountStepBtn} onClick={() => adjustAmount(1)}>
                <span className={styles.amountStepShadow} />
                <span className={styles.amountStepFace}>
                  <IconAdd size={22} color={Colors.dashboard.stroke} />
                </span>
              </button>
            </div>
            {!isGroup && foodUnit !== 'g' ? (
              <div className={styles.unitSegment} role="group" aria-label={t('food.servingUnit')}>
                <button
                  type="button"
                  className={`${styles.unitSegmentBtn} ${displayUnit === foodUnit ? styles.unitSegmentBtnActive : ''}`}
                  onClick={() => switchDisplayUnit(foodUnit)}
                >
                  {unitLabel(foodUnit)}
                </button>
                <button
                  type="button"
                  className={`${styles.unitSegmentBtn} ${displayUnit === 'g' ? styles.unitSegmentBtnActive : ''}`}
                  onClick={() => switchDisplayUnit('g')}
                >
                  {t('food.unitG')}
                </button>
              </div>
            ) : null}
            {displayUnit !== 'g' ? (
              <div className={styles.amountMetaRow}>
                <span className={styles.amountMetaLabel}>{t('food.amount')}</span>
                <span className={styles.amountMetaValue}>
                  {t('food.amountEqualsGrams', { grams: Math.round(g * 10) / 10 })}
                </span>
              </div>
            ) : null}
          </GlassCardSimple>

          <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
            <div className={styles.sectionHeaderSmall}>
              <SectionIcon background={Colors.dashboard.blobMint}>
                <IconPieChartOutline size={20} color={Colors.dashboard.stroke} />
              </SectionIcon>
              <span className={styles.sectionTitle}>Makrotápanyagok</span>
            </div>
            <div className={styles.macroEnergyRow}>
              <div className={styles.energyLeft}>
                <IconBolt size={20} color={Colors.dashboard.nutritionIcon} />
                <span className={styles.energyLabel}>{t('food.energy').toUpperCase()}</span>
              </div>
              <span className={styles.energyValue}>{calc.kcal} kcal</span>
            </div>
            <div className={styles.macroBars}>
              <MacroBar
                label={t('food.protein')}
                grams={calc.protein}
                percent={proteinPct}
                color={Colors.dashboard.proteinFill}
                rotation={0.5}
              />
              <MacroBar
                label={t('food.carbs')}
                grams={calc.carbs}
                percent={carbsPct}
                color={Colors.dashboard.carbsFill}
                rotation={-0.5}
                sugarNote={
                  calc.sugar != null
                    ? `${t('food.ofWhichSugar')}: ${calc.sugar}g`
                    : undefined
                }
              />
              <MacroBar
                label={t('food.fat')}
                grams={calc.fat}
                percent={fatPct}
                color={Colors.dashboard.fatFill}
                rotation={-0.5}
              />
            </div>
          </GlassCardSimple>

          <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
            <div className={styles.sectionHeaderSmall}>
              <SectionIcon background={Colors.dashboard.blobPeach}>
                <IconRestaurantOutline size={20} color={Colors.dashboard.stroke} />
              </SectionIcon>
              <span className={styles.sectionTitle}>{t('food.mealType')}</span>
            </div>
            <div className={styles.mealRow}>
              {MEAL_TYPES.map((m) => {
                const active = mealType === m;
                return (
                  <button
                    key={m}
                    type="button"
                    className={styles.mealBtnWrap}
                    onClick={() => setMealType(m)}
                  >
                    {active && <span className={styles.mealBtnShadow} />}
                    <span className={`${styles.mealBtnInner} ${active ? styles.mealBtnInnerActive : ''}`}>
                      <span className={`${styles.mealBtnText} ${active ? styles.mealBtnTextActive : ''}`}>
                        {mealLabel(m)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </GlassCardSimple>

          <div className={styles.scrollSpacer} />
        </div>
      </div>

      <footer className={styles.detailFooter}>
        <div className={styles.editFooterRow}>
          <button
            type="button"
            className={styles.deleteBtnWrap}
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            <span className={styles.deleteBtnShadow} />
            <span className={styles.deleteBtnInner}>
              {deleting ? '...' : t('common.delete', 'Törlés')}
            </span>
          </button>
          <button
            type="button"
            className={styles.addBtnWrap}
            onClick={handleSave}
            disabled={busy}
          >
            <span className={styles.addBtnShadow} />
            <span className={styles.addBtnInner}>
              <span className={styles.addBtnLabel}>
                {saving ? 'Folyamatban...' : t('common.save')}
              </span>
            </span>
          </button>
        </div>
      </footer>

      <ConfirmDialog
        visible={confirmDelete}
        title={isGroup ? t('food.deleteLogGroupTitle') : t('common.delete', 'Törlés')}
        message={
          isGroup
            ? t('food.deleteLogGroupMessage')
            : t('food.confirmDeleteLog', 'Biztosan törölöd ezt a bejegyzést?')
        }
        confirmLabel={t('common.delete', 'Törlés')}
        cancelLabel={t('common.cancel', 'Mégse')}
        destructive
        onConfirm={handleDeleteConfirm}
        onClose={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ''}
        message={dialog?.message ?? ''}
        confirmLabel={t('common.ok', 'OK')}
        onClose={() => setDialog(null)}
      />

      {editFood ? (
        <EditFoodModal
          visible={editOpen}
          food={editFood}
          onClose={() => {
            setEditOpen(false);
            setEditFood(null);
          }}
          onUpdated={(updated) => {
            setEditFood(updated);
            setEditOpen(false);
            onSaved?.();
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

interface AddFoodManualModalProps {
  visible: boolean;
  prefillBarcode?: string;
  prefillName?: string;
  onClose: () => void;
  onCreated?: (food: Food) => void;
  onOpenScanner?: () => void;
  onOpenAiRecognize?: () => void;
}

export function AddFoodManualModal({
  visible,
  prefillBarcode,
  prefillName,
  onClose,
  onCreated,
  onOpenScanner,
  onOpenAiRecognize,
}: AddFoodManualModalProps) {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const userId = useAuthStore((s) => s.user?.id);
  const [query, setQuery] = useState(prefillName ?? prefillBarcode ?? '');
  const [foods, setFoods] = useState<Food[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('recent');
  const [favBusyId, setFavBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Food | null>(null);
  const [deletingFood, setDeletingFood] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [openCounts, setOpenCounts] = useState<Record<string, number>>({});
  const cleanQuery = query.trim();
  const searchSeq = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openCountsRef = useRef(openCounts);
  const isSearching = cleanQuery.length >= 2;
  const searchScope: FilterTab | null =
    isSearching && activeTab !== 'recent' ? activeTab : null;
  const suggestions = matchSearchSuggestions(searchHistory, query);

  openCountsRef.current = openCounts;

  const applyFoods = (list: Food[]) => {
    setFoods(rankFoodsByOpens(list, openCountsRef.current));
  };

  useEffect(() => {
    if (!visible) return;
    setQuery(prefillName ?? prefillBarcode ?? '');
    setActiveTab('recent');
    setCreateOpen(false);
    void loadFoodSearchHistory(userId).then(setSearchHistory);
    void loadFoodOpenCounts(userId).then(setOpenCounts);
  }, [visible, prefillName, prefillBarcode, userId]);

  useEffect(() => {
    if (!visible) return;

    const seq = ++searchSeq.current;

    if (isSearching) {
      const timer = setTimeout(async () => {
        setLoading(true);
        try {
          const scoped = searchScope === 'mine' || searchScope === 'favorites' || searchScope === 'frequent';
          const res = await foodApi.search(cleanQuery, {
            limit: scoped ? 50 : 20,
            mine: searchScope === 'mine',
            scope: searchScope === 'favorites' || searchScope === 'frequent' ? searchScope : undefined,
          });
          if (seq !== searchSeq.current) return;
          applyFoods(res.foods);
          const nextHistory = await rememberFoodSearch(cleanQuery, userId);
          if (seq === searchSeq.current) setSearchHistory(nextHistory);
        } catch {
          if (seq !== searchSeq.current) return;
          setFoods([]);
        } finally {
          if (seq === searchSeq.current) setLoading(false);
        }
      }, 400);
      return () => clearTimeout(timer);
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let res: { foods: Food[] };
        if (activeTab === 'favorites') res = await foodApi.favorites(50);
        else if (activeTab === 'frequent') res = await foodApi.frequent(20);
        else if (activeTab === 'mine') res = await foodApi.search('', { limit: 30, mine: true });
        else res = await foodApi.recent(20);
        if (cancelled || seq !== searchSeq.current) return;
        applyFoods(res.foods);
      } catch {
        if (cancelled || seq !== searchSeq.current) return;
        setFoods([]);
      } finally {
        if (!cancelled && seq === searchSeq.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cleanQuery, visible, activeTab, isSearching, searchScope, userId]);

  const toggleFavorite = async (item: Food, e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (favBusyId) return;
    setFavBusyId(item.id);
    const next = !item.isFavorite;
    setFoods((prev) => prev.map((f) => (f.id === item.id ? { ...f, isFavorite: next } : f)));
    try {
      if (next) await foodApi.addFavorite(item.id);
      else await foodApi.removeFavorite(item.id);
      if (activeTab === 'favorites' && !isSearching && !next) {
        setFoods((prev) => prev.filter((f) => f.id !== item.id));
      }
    } catch (err: any) {
      setFoods((prev) => prev.map((f) => (f.id === item.id ? { ...f, isFavorite: item.isFavorite } : f)));
      window.alert(err?.message || t('food.errorTitle'));
    } finally {
      setFavBusyId(null);
    }
  };

  if (!visible) return null;

  const getDisplayName = (item: Food) =>
    (i18n.language === 'en' ? item.nameEn : item.nameHu) ?? item.displayName ?? item.name;

  const showSkeleton = !isSearching && loading && foods.length === 0;
  const emptyHint = isSearching
    ? t('food.noResults')
    : activeTab === 'favorites'
      ? t('food.emptyFavorites')
      : activeTab === 'frequent'
        ? t('food.emptyFrequent')
        : activeTab === 'mine'
          ? t('food.emptyMine')
          : t('food.emptyRecent');

  return createPortal(
    <div className={styles.addOverlay}>
      <div className={styles.addScreen}>
        <div className={styles.addHeaderBand}>
          <div className={styles.addHeaderTop}>
            <button type="button" className={styles.iconBtnAbsolute} onClick={onClose}>
              <span className={styles.iconShadow} />
              <span className={styles.iconFace}>
                <IconArrowBack size={20} color={Colors.dashboard.stroke} />
              </span>
            </button>
            <h2 className={styles.addTitle}>{t('food.manualAddTitle')}</h2>
            <button
              type="button"
              className={styles.iconBtnAbsoluteRight}
              aria-label={t('food.newFood')}
              onClick={() => setCreateOpen(true)}
            >
              <span className={styles.iconShadow} />
              <span className={styles.iconFace}>
                <IconAdd size={22} color={Colors.dashboard.stroke} />
              </span>
            </button>
          </div>

          <div className={styles.searchWrap}>
            <span className={styles.searchShadow} />
            <div className={styles.searchBoxInner}>
              <IconSearch size={18} color={Colors.dashboard.tabInactive} />
              <input
                ref={searchInputRef}
                className={styles.searchInputInner}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('food.searchPlaceholder')}
                autoFocus
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  className={styles.searchClearBtn}
                  aria-label={t('food.clearSearch')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <IconClose size={16} color={Colors.dashboard.stroke} />
                </button>
              ) : null}
            </div>
          </div>

          {suggestions.length > 0 ? (
            <div className={styles.suggestRow} aria-label={t('food.searchSuggestions')}>
              {suggestions.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={styles.suggestChip}
                  onClick={() => setQuery(item)}
                >
                  <span className={styles.suggestChipText}>{item}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.tabRow}>
            {FILTER_TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`${styles.tabChip} ${active ? styles.tabChipActive : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className={active ? styles.tabChipTextActive : styles.tabChipText}>
                    {t(tab.labelKey)}
                  </span>
                </button>
              );
            })}
          </div>

          {(onOpenAiRecognize || onOpenScanner) && (
            <div className={styles.quickActionRow}>
              {onOpenAiRecognize && (
                <button
                  type="button"
                  className={styles.quickActionWrap}
                  onClick={() => {
                    onClose();
                    onOpenAiRecognize();
                  }}
                >
                  <span className={styles.quickActionShadow} />
                  <span className={`${styles.quickActionInner} ${styles.quickActionAi}`}>
                    <IconBrain size={18} color={Colors.dashboard.stroke} />
                    <span className={styles.quickActionLabel}>{t('aiRecognize.entryShort')}</span>
                  </span>
                </button>
              )}
              {onOpenScanner && (
                <button
                  type="button"
                  className={styles.quickActionWrap}
                  onClick={() => {
                    onClose();
                    onOpenScanner();
                  }}
                >
                  <span className={styles.quickActionShadow} />
                  <span className={`${styles.quickActionInner} ${styles.quickActionScan}`}>
                    <IconQrCodeScanner size={18} color={Colors.dashboard.stroke} />
                    <span className={styles.quickActionLabel}>{t('food.scanBarcodeShort')}</span>
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className={styles.addBody}>
          <GlassCardSimple padding={16} shadowOffset={3}>
            {showSkeleton ? (
              <div className={styles.skeletonWrap}>
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className={styles.skeletonRow}>
                    <div className={styles.skeletonAvatar} />
                    <div className={styles.skeletonTextCol}>
                      <div className={`${styles.skeletonLine} ${styles.skeletonLineMain}`} />
                      <div className={`${styles.skeletonLine} ${styles.skeletonLineSub}`} />
                    </div>
                    <div className={styles.skeletonCircle} />
                  </div>
                ))}
              </div>
            ) : loading && isSearching ? (
              <div className={styles.loadingWrap}>
                <div className="spinner" />
                <p className={styles.emptyHint}>{t('food.searching')}</p>
              </div>
            ) : foods.length === 0 ? (
              <div className={styles.loadingWrap}>
                <p className={styles.emptyHint}>{emptyHint}</p>
              </div>
            ) : (
              foods.map((item) => {
                const name = getDisplayName(item);
                const brand = distinctBrand(name, item.brand);
                return (
                <SwipeDeleteRow
                  key={item.id}
                  enabled={isAdmin && isLocalFoodId(item.id)}
                  deleteLabel={t('common.delete', 'Törlés')}
                  onDelete={() => setDeleteTarget(item)}
                >
                <div className={styles.quickRow}>
                  <button
                    type="button"
                    className={styles.quickRowMain}
                    onClick={() => {
                      void bumpFoodOpen(item.id, userId).then(setOpenCounts);
                      onCreated?.(item);
                    }}
                  >
                    <OriginIcon item={item} />
                    <span className={styles.resultInfo}>
                      <span className={styles.quickName}>{name}</span>
                      {brand ? <span className={styles.quickBrand}>{brand}</span> : null}
                      <span className={styles.quickMeta}>{Math.round(item.kcal)} kcal / 100g</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.quickFavBtn}
                    aria-label={item.isFavorite ? t('food.unfavorite') : t('food.favorite')}
                    disabled={favBusyId === item.id}
                    onClick={(e) => toggleFavorite(item, e)}
                  >
                    {item.isFavorite ? (
                      <IconHeart size={18} color={Colors.dashboard.nutritionIcon} />
                    ) : (
                      <IconHeartOutline size={18} color={Colors.dashboard.stroke} />
                    )}
                  </button>
                </div>
                </SwipeDeleteRow>
              );
              })
            )}
          </GlassCardSimple>
        </div>
      </div>

      <CreateFoodModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(food) => {
          setCreateOpen(false);
          onCreated?.(food);
        }}
      />

      <ConfirmDialog
        visible={!!deleteTarget}
        title={t('food.confirmDeleteFoodTitle')}
        message={t('food.confirmDeleteFood')}
        confirmLabel={t('common.delete', 'Törlés')}
        cancelLabel={t('common.cancel', 'Mégse')}
        destructive
        onConfirm={() => {
          const target = deleteTarget;
          if (!target || deletingFood) return;
          setDeletingFood(true);
          void adminApi
            .deleteFood(target.id)
            .then(() => {
              setFoods((prev) => prev.filter((f) => f.id !== target.id));
            })
            .catch((e: any) => {
              window.alert(e?.message || t('food.errorTitle'));
            })
            .finally(() => {
              setDeletingFood(false);
              setDeleteTarget(null);
            });
        }}
        onClose={() => {
          if (!deletingFood) setDeleteTarget(null);
        }}
      />
    </div>,
    document.body,
  );
}

interface CreateFoodModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated?: (food: Food) => void;
  initialBarcode?: string;
}

interface EditFoodModalProps {
  visible: boolean;
  food: Food;
  onClose: () => void;
  onUpdated?: (food: Food) => void;
}

function FoodDataFormModal({
  visible,
  mode,
  initialFood,
  initialBarcode,
  onClose,
  onSaved,
}: {
  visible: boolean;
  mode: 'create' | 'edit';
  initialFood?: Food | null;
  initialBarcode?: string;
  onClose: () => void;
  onSaved?: (food: Food) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [barcode, setBarcode] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  const [sugar, setSugar] = useState('');
  const [servingUnit, setServingUnit] = useState<ServingUnitCode>('g');
  const [servingGrams, setServingGrams] = useState('100');
  const [servingEstimateBusy, setServingEstimateBusy] = useState(false);
  const [estimateHint, setEstimateHint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string } | null>(null);
  const [aiView, setAiView] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiPreviewUrl, setAiPreviewUrl] = useState<string | null>(null);
  const [aiImageFile, setAiImageFile] = useState<File | null>(null);
  const [approxNote, setApproxNote] = useState<string | null>(null);
  const [servingInfoOpen, setServingInfoOpen] = useState(false);
  const [isPreparedRecipe, setIsPreparedRecipe] = useState(false);
  const [recipeComponents, setRecipeComponents] = useState<RecipeCompDraft[]>([]);
  const recipeOrigRef = useRef<RecipeCompDraft[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const resetAiCapture = () => {
    if (aiPreviewUrl) URL.revokeObjectURL(aiPreviewUrl);
    setAiPreviewUrl(null);
    setAiImageFile(null);
    setAiBusy(false);
  };

  useEffect(() => {
    if (!visible) return;
    if (mode === 'edit' && initialFood) {
      const display =
        (i18n.language === 'en' ? initialFood.nameEn : initialFood.nameHu) ??
        initialFood.displayName ??
        initialFood.name;
      setName(display);
      setBrand(initialFood.brand ?? '');
      setBarcode(initialFood.barcode ?? '');
      setKcal(String(initialFood.kcal ?? ''));
      setProtein(String(initialFood.protein ?? ''));
      setCarbs(String(initialFood.carbs ?? ''));
      setFat(String(initialFood.fat ?? ''));
      setFiber(initialFood.fiber != null ? String(initialFood.fiber) : '');
      setSugar(initialFood.sugar != null ? String(initialFood.sugar) : '');
      setServingUnit(normalizeServingUnit(initialFood.servingUnit));
      setServingGrams(
        String(
          initialFood.servingSize != null && initialFood.servingSize > 0
            ? initialFood.servingSize
            : 100,
        ),
      );
      const comps = initialFood.components ?? [];
      setIsPreparedRecipe(!!initialFood.isPrepared && comps.length > 0);
      const mapped: RecipeCompDraft[] = comps.map((c, i) => ({
        key: c.id ?? `c-${i}`,
        name: c.name,
        amountG: String(c.amountG),
        kcal: String(c.kcal),
        protein: String(c.protein),
        carbs: String(c.carbs),
        fat: String(c.fat),
      }));
      recipeOrigRef.current = mapped;
      setRecipeComponents(mapped);
    } else {
      setName('');
      setBrand('');
      setBarcode(initialBarcode?.trim() ?? '');
      setKcal('');
      setProtein('');
      setCarbs('');
      setFat('');
      setFiber('');
      setSugar('');
      setServingUnit('g');
      setServingGrams('100');
      setIsPreparedRecipe(false);
      recipeOrigRef.current = [];
      setRecipeComponents([]);
    }
    setServingEstimateBusy(false);
    setEstimateHint(false);
    setDialog(null);
    setApproxNote(null);
    setAiView(false);
    setServingInfoOpen(false);
    resetAiCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode, initialFood, initialBarcode]);

  useEffect(() => {
    return () => {
      if (aiPreviewUrl) URL.revokeObjectURL(aiPreviewUrl);
    };
  }, [aiPreviewUrl]);

  useEffect(() => {
    if (!aiBusy) {
      setAiProgress(0);
      return;
    }
    setAiProgress(5);
    const steps = [
      { delay: 400, value: 20 },
      { delay: 900, value: 40 },
      { delay: 1800, value: 58 },
      { delay: 3000, value: 72 },
      { delay: 4500, value: 84 },
      { delay: 6500, value: 91 },
      { delay: 9000, value: 95 },
    ];
    const timers = steps.map(({ delay, value }) =>
      setTimeout(() => setAiProgress(value), delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [aiBusy]);

  if (!visible) return null;

  const showDialog = (title: string, message: string) => setDialog({ title, message });

  const num = (v: string) => {
    const n = parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };

  const unitLabel = (u: ServingUnitCode) => {
    if (u === 'g') return t('food.unitG');
    if (u === 'db') return t('food.unitDb');
    if (u === 'adag') return t('food.unitAdag');
    if (u === 'ek') return t('food.unitEk');
    return t('food.unitSzelet');
  };

  const canEstimateServing =
    name.trim().length > 0 &&
    [kcal, protein, carbs, fat].every((v) => {
      const n = num(v);
      return Number.isFinite(n) && n >= 0 && String(v).trim() !== '';
    });

  const fmtNum = (n: number) => String(Math.round(n * 10) / 10);

  const openServingInfo = () => {
    setServingInfoOpen(true);
  };

  const previewServingMacros = (() => {
    const grams = num(servingGrams);
    const k = num(kcal);
    const p = num(protein);
    const c = num(carbs);
    const f = num(fat);
    if (![grams, k, p, c, f].every((n) => Number.isFinite(n) && n >= 0) || grams <= 0) {
      return null;
    }
    const fiberN = fiber.trim() ? num(fiber) : null;
    const sugarN = sugar.trim() ? num(sugar) : null;
    return macrosForGrams(
      {
        kcal: k,
        protein: p,
        carbs: c,
        fat: f,
        fiber: fiberN != null && Number.isFinite(fiberN) ? fiberN : null,
        sugar: sugarN != null && Number.isFinite(sugarN) ? sugarN : null,
      },
      grams,
    );
  })();

  const onPickAiPhoto = (file: File | null) => {
    if (!file) return;
    if (aiPreviewUrl) URL.revokeObjectURL(aiPreviewUrl);
    setAiImageFile(file);
    setAiPreviewUrl(URL.createObjectURL(file));
  };

  const runAiLabelFill = async () => {
    if (!aiImageFile) {
      showDialog(t('food.errorTitle'), t('food.aiFill.needPhoto'));
      return;
    }
    setAiBusy(true);
    try {
      const { base64, mimeType } = await fileToCompressedJpeg(aiImageFile);
      const locale = i18n.language?.startsWith('en') ? 'en' : 'hu';
      const res = await foodApi.aiLabelFill({
        imageBase64: base64,
        mimeType,
        locale,
      });
      setName(res.name || '');
      setBrand(res.brand?.trim() || '');
      setBarcode(res.barcode?.trim() || '');
      setKcal(fmtNum(res.kcal));
      setProtein(fmtNum(res.protein));
      setCarbs(fmtNum(res.carbs));
      setFat(fmtNum(res.fat));
      setFiber(res.fiber != null ? fmtNum(res.fiber) : '');
      setSugar(res.sugar != null ? fmtNum(res.sugar) : '');
      setApproxNote(
        res.isApproximate
          ? (res.approximateNote?.trim() || t('food.aiFill.approxFallback'))
          : null,
      );
      resetAiCapture();
      setAiView(false);
    } catch (e: unknown) {
      showDialog(t('food.errorTitle'), getErrorMessage(e, t('food.aiFill.failed')));
    } finally {
      setAiBusy(false);
    }
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    const missing: string[] = [];
    if (trimmed.length < 2) missing.push(t('food.foodName'));

    let k = num(kcal);
    let p = num(protein);
    let c = num(carbs);
    let f = num(fat);
    let servingN = num(servingGrams);
    let componentsPayload:
      | Array<{
          name: string;
          amountG: number;
          kcal: number;
          protein: number;
          carbs: number;
          fat: number;
          sortOrder: number;
        }>
      | undefined;

    if (isPreparedRecipe) {
      const parsedComps = recipeComponents.map((row, i) => ({
        name: row.name.trim(),
        amountG: num(row.amountG),
        kcal: num(row.kcal),
        protein: num(row.protein),
        carbs: num(row.carbs),
        fat: num(row.fat),
        sortOrder: i,
      }));
      if (
        parsedComps.length === 0 ||
        parsedComps.some(
          (x) =>
            !x.name ||
            ![x.amountG, x.kcal, x.protein, x.carbs, x.fat].every((n) => Number.isFinite(n) && n >= 0) ||
            x.amountG <= 0,
        )
      ) {
        showDialog(t('food.missingDataTitle'), t('food.preparedRecipeInvalid'));
        return;
      }
      const totalG = parsedComps.reduce((s, x) => s + x.amountG, 0);
      const totals = parsedComps.reduce(
        (acc, x) => ({
          kcal: acc.kcal + x.kcal,
          protein: acc.protein + x.protein,
          carbs: acc.carbs + x.carbs,
          fat: acc.fat + x.fat,
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      );
      const per100 = (n: number) => Math.round((n / totalG) * 100 * 10) / 10;
      k = per100(totals.kcal);
      p = per100(totals.protein);
      c = per100(totals.carbs);
      f = per100(totals.fat);
      servingN = Math.round(totalG * 10) / 10;
      componentsPayload = parsedComps;
    } else {
      if (!Number.isFinite(k) || k < 0) missing.push(t('food.caloriesPer100g'));
      if (!Number.isFinite(p) || p < 0) missing.push(t('food.proteinPer100g'));
      if (!Number.isFinite(c) || c < 0) missing.push(t('food.carbsPer100g'));
      if (!Number.isFinite(f) || f < 0) missing.push(t('food.fatPer100g'));
      if (!Number.isFinite(servingN) || servingN <= 0) {
        showDialog(
          t('food.missingDataTitle'),
          t('food.servingGramsPerUnit', { unit: unitLabel(servingUnit) }),
        );
        return;
      }
    }

    if (missing.length) {
      showDialog(t('food.missingDataTitle'), t('food.fillFields', { fields: missing.join(', ') }));
      return;
    }

    const fiberN = fiber.trim() ? num(fiber) : undefined;
    const sugarN = sugar.trim() ? num(sugar) : undefined;
    if (fiberN != null && (!Number.isFinite(fiberN) || fiberN < 0)) {
      showDialog(t('food.missingDataTitle'), t('food.fiberPer100g'));
      return;
    }
    if (sugarN != null && (!Number.isFinite(sugarN) || sugarN < 0)) {
      showDialog(t('food.missingDataTitle'), t('food.sugarPer100g'));
      return;
    }

    setSubmitting(true);
    try {
      const brandTrim = brand.trim();
      const barcodeTrim = barcode.trim();
      const payload = {
        name: trimmed,
        nameHu: trimmed,
        nameEn: trimmed,
        brand: brandTrim || null,
        barcode: barcodeTrim || null,
        kcal: k,
        protein: p,
        carbs: c,
        fat: f,
        fiber: fiberN ?? null,
        sugar: sugarN ?? null,
        servingSize: servingN,
        servingUnit: isPreparedRecipe ? ('adag' as const) : servingUnit,
        isPrepared: isPreparedRecipe,
        ...(componentsPayload ? { components: componentsPayload } : {}),
      };

      const saved =
        mode === 'edit' && initialFood
          ? await foodApi.update(initialFood.id, payload)
          : await foodApi.create({
              ...payload,
              source: 'USER_SCAN',
              brand: brandTrim || undefined,
              barcode: barcodeTrim || undefined,
            });

      onSaved?.(saved);
    } catch (e: any) {
      showDialog(t('food.errorTitle'), getErrorMessage(e, t('food.errorTitle')));
    } finally {
      setSubmitting(false);
    }
  };

  const headerBack = () => {
    if (aiView) {
      resetAiCapture();
      setAiView(false);
      return;
    }
    onClose();
  };

  return createPortal(
    <>
      <div className={styles.detailScreen}>
        <header className={styles.detailHeader}>
          <button type="button" className={styles.backBtn} onClick={headerBack}>
            <span className={styles.backBtnShadow} />
            <span className={styles.backBtnInner}>
              <IconArrowBack size={24} color={Colors.dashboard.stroke} />
            </span>
          </button>
          <h2 className={styles.detailTitle}>
            {aiView
              ? t('food.aiFill.button')
              : mode === 'edit'
                ? t('food.editFoodTitle')
                : t('food.createFoodTitle')}
          </h2>
          {mode === 'create' && !aiView ? (
            <button
              type="button"
              className={styles.headerAiBtn}
              aria-label={t('food.aiFill.aria')}
              onClick={() => setAiView(true)}
            >
              <span className={styles.headerAiShadow} />
              <span className={styles.headerAiInner}>
                <IconBrain size={18} color={Colors.dashboard.stroke} />
                <IconAdd size={12} color={Colors.dashboard.stroke} />
              </span>
            </button>
          ) : (
            <span className={styles.headerSpacer} />
          )}
        </header>

        <div className={styles.detailBody}>
          {aiView ? (
            <div className={styles.sections}>
              <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
                <p className={styles.aiFillLead}>{t('food.aiFill.cameraLead')}</p>
                <p className={styles.aiFillHint}>{t('food.aiFill.photoNotStored')}</p>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className={styles.hiddenFile}
                  onChange={(e) => {
                    onPickAiPhoto(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/*"
                  className={styles.hiddenFile}
                  onChange={(e) => {
                    onPickAiPhoto(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                />
                {aiPreviewUrl ? (
                  <img src={aiPreviewUrl} alt="" className={styles.aiFillPreview} />
                ) : null}
                <div className={styles.aiFillActions}>
                  <button
                    type="button"
                    className={styles.aiFillSecondary}
                    disabled={aiBusy}
                    onClick={() => cameraInputRef.current?.click()}
                  >
                    <IconPhotoCamera size={22} color={Colors.dashboard.stroke} />
                    {aiPreviewUrl ? t('food.aiFill.retake') : t('food.aiFill.takePhoto')}
                  </button>
                  <button
                    type="button"
                    className={styles.aiFillSecondary}
                    disabled={aiBusy}
                    onClick={() => galleryInputRef.current?.click()}
                  >
                    <IconPhotoLibrary size={22} color={Colors.dashboard.stroke} />
                    {t('food.aiFill.pickGallery')}
                  </button>
                  <button
                    type="button"
                    className={styles.aiFillPrimary}
                    disabled={aiBusy || !aiImageFile}
                    onClick={runAiLabelFill}
                  >
                    {aiBusy ? t('food.aiFill.run') : t('food.aiFill.run')}
                  </button>
                  {aiBusy && (
                    <div className={styles.aiProgressCard} aria-live="polite" role="status">
                      <div className={styles.aiProgressHead}>
                        <div className={styles.aiProgressStatus}>
                          <span className={styles.aiProgressDot} />
                          <span className={styles.aiProgressStepText}>{t('food.aiFill.run')}</span>
                        </div>
                        <span className={styles.aiProgressPercent}>{aiProgress}%</span>
                      </div>
                      <div className={styles.aiProgressTrack}>
                        <div className={styles.aiProgressFill} style={{ width: `${aiProgress}%` }}>
                          <span className={styles.aiProgressStripes}>
                            {'//////// //////// //////// //////// //////// ////////'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </GlassCardSimple>
              <div className={styles.scrollSpacer} />
            </div>
          ) : (
            <div className={styles.sections}>
              <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
                <div className={styles.sectionHeaderSmall}>
                  <SectionIcon background={Colors.dashboard.blobMint}>
                    <IconLeaf size={20} color={Colors.dashboard.stroke} />
                  </SectionIcon>
                  <span className={styles.sectionTitle}>{t('food.baseData')}</span>
                </div>
                <label className={styles.formLabel}>{t('food.foodName')}</label>
                <input
                  className={styles.formInput}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('food.foodName')}
                  autoFocus
                />
                <label className={styles.preparedCheck}>
                  <span
                    className={styles.preparedCheckBox}
                    data-checked={isPreparedRecipe || undefined}
                  >
                    <input
                      type="checkbox"
                      checked={isPreparedRecipe}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setIsPreparedRecipe(on);
                        if (on && recipeComponents.length === 0) {
                          const grams = num(servingGrams);
                          const factor =
                            Number.isFinite(grams) && grams > 0 ? grams / 100 : 1;
                          const scale = (raw: string) => {
                            if (!raw.trim()) return '';
                            const n = num(raw);
                            return Number.isFinite(n) ? String(Math.round(n * factor * 10) / 10) : '';
                          };
                          const seeded: RecipeCompDraft[] = [
                            {
                              key: `c-${Date.now()}`,
                              name: name.trim(),
                              amountG: servingGrams.trim() || '100',
                              kcal: scale(kcal),
                              protein: scale(protein),
                              carbs: scale(carbs),
                              fat: scale(fat),
                            },
                          ];
                          recipeOrigRef.current = seeded;
                          setRecipeComponents(seeded);
                        }
                      }}
                    />
                    {isPreparedRecipe ? '✓' : null}
                  </span>
                  <span className={styles.preparedCheckText}>
                    <strong>{t('food.createAsPrepared')}</strong>
                    <small>{t('food.preparedRecipeHint')}</small>
                  </span>
                </label>
                <label className={styles.formLabel}>{t('food.brandOptional')}</label>
                <input
                  className={styles.formInput}
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder={t('food.brandOptional')}
                />
                <label className={styles.formLabel}>{t('food.barcodeOptional')}</label>
                <input
                  className={styles.formInput}
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder={t('food.barcodeOptional')}
                  inputMode="numeric"
                />
              </GlassCardSimple>

              {isPreparedRecipe && (
                <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
                  <div className={styles.sectionHeaderSmall}>
                    <SectionIcon background={Colors.dashboard.blobPeach}>
                      <IconRestaurantOutline size={20} color={Colors.dashboard.stroke} />
                    </SectionIcon>
                    <span className={styles.sectionTitle}>{t('food.preparedIngredients')}</span>
                  </div>
                  <p className={styles.recipeHint}>{t('food.preparedRecipeHint')}</p>
                  {recipeComponents.map((row, index) => (
                    <div key={row.key} className={styles.recipeCard}>
                      <div className={styles.recipeCardHead}>
                        <span className={styles.recipeIndex}>{index + 1}</span>
                        <input
                          className={styles.formInput}
                          value={row.name}
                          placeholder={t('food.ingredientName')}
                          onChange={(e) =>
                            setRecipeComponents((prev) =>
                              prev.map((r) =>
                                r.key === row.key ? { ...r, name: e.target.value } : r,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className={styles.recipeDeleteBtn}
                          aria-label={t('common.delete', 'Törlés')}
                          disabled={recipeComponents.length <= 1}
                          onClick={() => {
                            recipeOrigRef.current = recipeOrigRef.current.filter(
                              (r) => r.key !== row.key,
                            );
                            setRecipeComponents((prev) => prev.filter((r) => r.key !== row.key));
                          }}
                        >
                          <IconClose size={18} color="#B83B3B" />
                        </button>
                      </div>
                      <div className={styles.recipeGrid}>
                        {(
                          [
                            { field: 'amountG', label: t('food.ingredientAmountG') },
                            { field: 'kcal', label: 'kcal' },
                            { field: 'protein', label: t('food.protein') },
                            { field: 'carbs', label: t('food.carbs') },
                            { field: 'fat', label: t('food.fat') },
                          ] as const
                        ).map(({ field, label }) => (
                          <label key={field} className={styles.recipeField}>
                            <span>{label}</span>
                            <input
                              className={styles.formInput}
                              inputMode="decimal"
                              value={row[field]}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/[^\d.,]/g, '');
                                setRecipeComponents((prev) =>
                                  prev.map((r) => {
                                    if (r.key !== row.key) return r;
                                    if (field !== 'amountG') {
                                      const next = { ...r, [field]: raw };
                                      recipeOrigRef.current = recipeOrigRef.current.map((o) =>
                                        o.key === row.key ? next : o,
                                      );
                                      return next;
                                    }
                                    const orig = recipeOrigRef.current.find((o) => o.key === row.key);
                                    const origAmt = orig ? parseQty(orig.amountG) : 0;
                                    const newAmt = parseQty(raw);
                                    if (!orig || origAmt <= 0) return { ...r, amountG: raw };
                                    return {
                                      ...scaleRecipeComp(orig, newAmt / origAmt),
                                      name: r.name,
                                      key: r.key,
                                    };
                                  }),
                                );
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={styles.recipeAddBtn}
                    onClick={() => {
                      const next: RecipeCompDraft = {
                        key: `c-${Date.now()}`,
                        name: '',
                        amountG: '100',
                        kcal: '',
                        protein: '',
                        carbs: '',
                        fat: '',
                      };
                      recipeOrigRef.current = [...recipeOrigRef.current, next];
                      setRecipeComponents((prev) => [...prev, next]);
                    }}
                  >
                    <IconAdd size={18} color={Colors.dashboard.stroke} />
                    {t('food.addIngredient')}
                  </button>
                  {(() => {
                    const parse = (v: string) => {
                      const n = Number(String(v).replace(',', '.'));
                      return Number.isFinite(n) ? n : 0;
                    };
                    const tot = recipeComponents.reduce(
                      (acc, r) => ({
                        g: acc.g + parse(r.amountG),
                        kcal: acc.kcal + parse(r.kcal),
                        protein: acc.protein + parse(r.protein),
                        carbs: acc.carbs + parse(r.carbs),
                        fat: acc.fat + parse(r.fat),
                      }),
                      { g: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 },
                    );
                    return (
                      <div className={styles.recipeTotals}>
                        <div className={styles.recipeTotalsTitle}>{t('food.recipeTotals')}</div>
                        <div className={styles.recipeTotalsRow}>
                          <span>{Math.round(tot.g * 10) / 10} g</span>
                          <span>{Math.round(tot.kcal * 10) / 10} kcal</span>
                        </div>
                        <div className={styles.recipeTotalsMacros}>
                          F {Math.round(tot.protein * 10) / 10}g · Sz{' '}
                          {Math.round(tot.carbs * 10) / 10}g · Zs {Math.round(tot.fat * 10) / 10}g
                        </div>
                      </div>
                    );
                  })()}
                </GlassCardSimple>
              )}

              <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
                <div className={styles.sectionHeaderSmall}>
                  <SectionIcon background={Colors.dashboard.softBlue}>
                    <IconScaleOutline size={20} color={Colors.dashboard.stroke} />
                  </SectionIcon>
                  <span className={styles.sectionTitle}>{t('food.servingUnit')}</span>
                  <div className={styles.servingHeaderActions}>
                    <button
                      type="button"
                      className={styles.portionInfoBtn}
                      aria-label={t('food.servingInfoAria')}
                      onClick={openServingInfo}
                    >
                      <IconInfoOutline size={18} color={Colors.dashboard.stroke} />
                    </button>
                  </div>
                </div>
                <p className={styles.servingUnitHint}>{t('food.servingUnitHint')}</p>
                <div className={styles.unitChipRow} role="group" aria-label={t('food.servingUnit')}>
                  {SERVING_UNITS.map((u) => {
                    const active = servingUnit === u;
                    return (
                      <button
                        key={u}
                        type="button"
                        className={`${styles.unitChip} ${active ? styles.unitChipActive : ''}`}
                        onClick={() => setServingUnit(u)}
                      >
                        {unitLabel(u)}
                      </button>
                    );
                  })}
                </div>
                <label className={styles.formLabel}>
                  {t('food.servingGramsPerUnit', { unit: unitLabel(servingUnit) })}
                </label>
                <div className={styles.servingGramsRow}>
                  <div className={styles.servingGramsInputWrap}>
                    <input
                      className={styles.servingGramsInput}
                      value={servingGrams}
                      onChange={(e) => setServingGrams(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="100"
                    />
                    <span className={styles.servingGramsSuffix}>g</span>
                  </div>
                  {servingUnit !== 'g' ? (
                    <button
                      type="button"
                      className={`${styles.aiEstimateBtn} ${!canEstimateServing ? styles.aiEstimateBtnInactive : ''}`}
                      disabled={servingEstimateBusy}
                      aria-disabled={!canEstimateServing}
                      onClick={async () => {
                        if (!canEstimateServing) {
                          setEstimateHint(true);
                          window.setTimeout(() => setEstimateHint(false), 3200);
                          return;
                        }
                        setEstimateHint(false);
                        setServingEstimateBusy(true);
                        try {
                          const locale = i18n.language?.startsWith('en') ? 'en' : 'hu';
                          const k = num(kcal);
                          const p = num(protein);
                          const c = num(carbs);
                          const f = num(fat);
                          const fiberN = fiber.trim() ? num(fiber) : undefined;
                          const sugarN = sugar.trim() ? num(sugar) : undefined;
                          const res = await foodApi.aiServingEstimate({
                            name: name.trim(),
                            brand: brand.trim() || undefined,
                            unit: servingUnit as 'db' | 'adag' | 'ek' | 'szelet',
                            locale,
                            kcal: k,
                            protein: p,
                            carbs: c,
                            fat: f,
                            ...(fiberN != null && Number.isFinite(fiberN) ? { fiber: fiberN } : {}),
                            ...(sugarN != null && Number.isFinite(sugarN) ? { sugar: sugarN } : {}),
                          });
                          setServingGrams(String(res.gramsPerUnit));
                        } catch (e: any) {
                          showDialog(
                            t('food.errorTitle'),
                            getErrorMessage(e, t('food.errorTitle')),
                          );
                        } finally {
                          setServingEstimateBusy(false);
                        }
                      }}
                    >
                      {servingEstimateBusy
                        ? t('food.aiEstimateServingBusy')
                        : t('food.aiEstimateServing')}
                    </button>
                  ) : null}
                </div>
                {servingUnit !== 'g' && estimateHint ? (
                  <div className={styles.aiEstimateBubble} role="status">
                    {t('food.aiEstimateServingNeedMacros')}
                  </div>
                ) : null}
              </GlassCardSimple>

              <GlassCardSimple padding={20} radius={24} shadowOffset={3}>
                <div className={styles.sectionHeaderSmall}>
                  <SectionIcon background={Colors.dashboard.blobLavender}>
                    <IconPieChartOutline size={20} color={Colors.dashboard.stroke} />
                  </SectionIcon>
                  <span className={styles.sectionTitle}>{t('food.nutritionPer100g')}</span>
                </div>
                <div className={styles.formGrid}>
                  <div className={styles.formField}>
                    <label className={styles.formLabel}>{t('food.caloriesPer100g')}</label>
                    <input
                      className={styles.formInput}
                      value={kcal}
                      onChange={(e) => setKcal(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label className={styles.formLabel}>{t('food.proteinPer100g')}</label>
                    <input
                      className={styles.formInput}
                      value={protein}
                      onChange={(e) => setProtein(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label className={styles.formLabel}>{t('food.carbsPer100g')}</label>
                    <input
                      className={styles.formInput}
                      value={carbs}
                      onChange={(e) => setCarbs(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label className={styles.formLabel}>{t('food.fatPer100g')}</label>
                    <input
                      className={styles.formInput}
                      value={fat}
                      onChange={(e) => setFat(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label className={styles.formLabel}>{t('food.fiberPer100g')}</label>
                    <input
                      className={styles.formInput}
                      value={fiber}
                      onChange={(e) => setFiber(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label className={styles.formLabel}>{t('food.sugarPer100g')}</label>
                    <input
                      className={styles.formInput}
                      value={sugar}
                      onChange={(e) => setSugar(e.target.value.replace(/[^\d.,]/g, ''))}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </div>
                </div>
                <p className={styles.formHint}>{t('food.infoPer100g')}</p>
              </GlassCardSimple>

              {approxNote ? <p className={styles.aiApproxNote}>{approxNote}</p> : null}

              <div className={styles.scrollSpacer} />
            </div>
          )}
        </div>

        {!aiView ? (
          <footer className={styles.detailFooter}>
            <button
              type="button"
              className={styles.addBtnWrap}
              onClick={handleSubmit}
              disabled={submitting}
            >
              <span className={styles.addBtnShadow} />
              <span className={styles.addBtnInner}>
                <IconAddCircle size={24} color="#fff" />
                <span className={styles.addBtnLabel}>
                  {submitting ? '...' : mode === 'edit' ? t('common.save', 'Mentés') : t('food.submit')}
                </span>
              </span>
            </button>
          </footer>
        ) : null}
      </div>
      <ServingUnitInfoPopup
        open={servingInfoOpen}
        onClose={() => setServingInfoOpen(false)}
        title={t('food.unitMacrosTitle', { unit: unitLabel(servingUnit) })}
        subtitle={
          Number.isFinite(num(servingGrams)) && num(servingGrams) > 0
            ? servingUnit === 'g'
              ? t('food.portionBadgeGrams', { grams: Math.round(num(servingGrams)) })
              : t('food.portionBadgeUnit', {
                  unit: unitLabel(servingUnit),
                  grams: Math.round(num(servingGrams) * 10) / 10,
                })
            : undefined
        }
        macros={previewServingMacros}
      />
      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ''}
        message={dialog?.message ?? ''}
        confirmLabel={t('common.ok', 'OK')}
        onClose={() => setDialog(null)}
      />
    </>,
    document.body,
  );
}

export function CreateFoodModal({ visible, onClose, onCreated, initialBarcode }: CreateFoodModalProps) {
  return (
    <FoodDataFormModal
      visible={visible}
      mode="create"
      initialBarcode={initialBarcode}
      onClose={onClose}
      onSaved={onCreated}
    />
  );
}

export function EditFoodModal({ visible, food, onClose, onUpdated }: EditFoodModalProps) {
  return (
    <FoodDataFormModal
      visible={visible}
      mode="edit"
      initialFood={food}
      onClose={onClose}
      onSaved={onUpdated}
    />
  );
}
