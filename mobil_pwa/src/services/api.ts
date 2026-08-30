import * as Storage from './storage';

/** Same-origin `/api` (Vite proxy) or absolute URL from env. */
const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) || '/api').replace(/\/$/, '');

/** Absolute API base for display / OAuth setup. */
export function getApiBaseUrl(): string {
  if (API_BASE.startsWith('http')) return API_BASE;
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${API_BASE.startsWith('/') ? '' : '/'}${API_BASE}`;
  }
  return API_BASE;
}

const API_VERBOSE = import.meta.env.DEV && import.meta.env.VITE_API_DEBUG === '1';

function apiDebug(...args: unknown[]) {
  if (API_VERBOSE) console.log(...args);
}

let accessToken: string | null = null;
export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function getAccessToken() {
  return accessToken;
}

export type ApiErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CONFLICT_EMAIL'
  | 'CONFLICT_USERNAME'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'MIXED_CONTENT';

export class ApiError extends Error {
  status: number;
  code?: ApiErrorCode;
  payload?: Record<string, unknown>;
  constructor(
    status: number,
    message: string,
    payload?: Record<string, unknown>,
    code?: ApiErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.code = code;
  }
}

/** Human-readable message for UI (always returns something useful). */
export function getErrorMessage(err: unknown, fallback = 'Váratlan hiba történt.'): string {
  let raw = '';
  if (err instanceof ApiError) raw = err.message || fallback;
  else if (err instanceof Error && err.message.trim()) raw = err.message;
  else raw = fallback;
  return clampUiMessage(raw, fallback);
}

/** Keep dialogs readable — API/Prisma dumps must not blow up the UI. */
export function clampUiMessage(message: string, fallback = 'Váratlan hiba történt.', max = 220): string {
  const cleaned = String(message ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function toNetworkApiError(error: unknown): ApiError {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();
  if (
    error instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed|aborted|the operation was aborted/i.test(lower)
  ) {
    const isHttpsPage =
      typeof window !== 'undefined' && window.location?.protocol === 'https:';
    const apiLooksHttp = API_BASE.startsWith('http://');
    if (isHttpsPage && apiLooksHttp) {
      return new ApiError(
        0,
        'A böngésző blokkolta a kérést (HTTPS oldal → HTTP API). Használd a /api proxyt vagy HTTPS API-t.',
        undefined,
        'MIXED_CONTENT',
      );
    }
    if (/aborted|timeout/i.test(lower)) {
      return new ApiError(
        0,
        'A kérés megszakadt vagy túl sokáig tartott. Próbálj kisebb fotót, vagy ismételd meg.',
        undefined,
        'TIMEOUT',
      );
    }
    return new ApiError(
      0,
      'Nem érhető el a szerver. Ellenőrizd a hálózatot, az API futását, és a VITE_API_URL / proxy beállítást.',
      undefined,
      'NETWORK_ERROR',
    );
  }
  return new ApiError(0, raw.trim() || 'Váratlan hiba történt a kérés közben.');
}

/** Abort signal for slow endpoints; older browsers without AbortSignal.timeout just wait. */
function requestTimeout(ms: number): { signal?: AbortSignal } {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms) };
  }
  return {};
}

let refreshInFlight: Promise<boolean> | null = null;

export async function refreshAccessTokenFromStorage(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const run = async (): Promise<boolean> => {
    try {
      const stored = await Storage.getItem('refreshToken');
      if (!stored) return false;
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: stored }),
      });
      if (!res.ok) {
        setAccessToken(null);
        return false;
      }
      const { accessToken: newAccess, refreshToken: newRefresh } = await res.json();
      setAccessToken(newAccess);
      await Storage.setItem('refreshToken', newRefresh);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    }
  };

  refreshInFlight = run().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  // Fastify rejects empty bodies when Content-Type is application/json (DELETE/GET → 400 Bad Request).
  const hasBody = options.body != null && options.body !== '';
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (
    hasBody &&
    !isFormData &&
    headers['Content-Type'] == null &&
    headers['content-type'] == null
  ) {
    headers['Content-Type'] = 'application/json';
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const url = `${API_BASE}${path}`;
  apiDebug(`[API] ${options.method || 'GET'} ${url}`);

  try {
    const response = await fetch(url, { ...options, headers });
    apiDebug(`[API] status ${response.status}`);

    const isAuthForm =
      path.startsWith('/auth/login') || path.startsWith('/auth/register');

    if (response.status === 401 && retry && !isAuthForm) {
      apiDebug('[API] 401 → refresh');
      const refreshed = await refreshAccessTokenFromStorage();
      if (refreshed) return request<T>(path, options, false);
      throw new ApiError(
        401,
        'A hitelesítés frissítése sikertelen. Próbáld újra később.',
        undefined,
        'AUTH_TOKEN_EXPIRED',
      );
    }

    const responseText = await response.text();
    apiDebug('[API] body', responseText);

    let data: any = null;
    if (responseText.trim()) {
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new ApiError(
          response.status,
          response.ok
            ? 'Érvénytelen válasz a szervertől.'
            : response.status === 502 || response.status === 504
              ? 'A felismerés nem ért célba (időtúllépés vagy túl nagy kép). Próbálj kisebb/élesebb fotót, vagy ismételd meg.'
              : response.status === 413
                ? 'A kép túl nagy. Próbálj kisebb felbontású fotót.'
                : `Szerver hiba (HTTP ${response.status}).`,
          undefined,
          response.status >= 500 ? 'SERVER_ERROR' : undefined,
        );
      }
    }

    if (!response.ok) {
      const rawError = typeof data?.error === 'string' ? data.error.trim() : '';
      const rawMessage = typeof data?.message === 'string' ? data.message.trim() : '';
      const isGenericEnglish =
        /^internal server error$/i.test(rawError) ||
        /^bad request$/i.test(rawError) ||
        /^unauthorized$/i.test(rawError) ||
        /^forbidden$/i.test(rawError) ||
        /^not found$/i.test(rawError);
      const preferred =
        (rawError && !isGenericEnglish ? rawError : '') ||
        (rawMessage && !isGenericEnglish ? rawMessage : '') ||
        '';
      const msg =
        preferred ||
        (response.status === 401
          ? 'Hibás email vagy jelszó.'
          : response.status === 403
            ? 'Nincs jogosultság ehhez a művelethez.'
            : response.status === 404
              ? 'A kért erőforrás nem található.'
              : response.status === 409
                ? 'Ez az adat már létezik.'
                : response.status === 429
                  ? 'Túl sok kérés. Várj egy percet, majd próbáld újra.'
                  : response.status === 413
                    ? 'A kép túl nagy. Próbálj kisebb felbontású fotót.'
                  : response.status === 502 || response.status === 504
                    ? 'A felismerés nem ért célba. Próbáld újra, vagy küldj kisebb fotót.'
                  : response.status >= 500
                    ? `Szerverhiba (HTTP ${response.status}).`
                    : `A kérés sikertelen (HTTP ${response.status}).`);

      // Derive a semantic code from status + backend message text
      let code: ApiErrorCode | undefined;
      if (response.status === 401 && isAuthForm) {
        code = 'AUTH_INVALID_CREDENTIALS';
      } else if (response.status === 401) {
        code = 'AUTH_TOKEN_EXPIRED';
      } else if (response.status === 403) {
        code = 'AUTH_FORBIDDEN';
      } else if (response.status === 404) {
        code = 'NOT_FOUND';
      } else if (response.status === 409) {
        // Detect which conflict type from the backend message
        const conflictText = preferred.toLowerCase();
        if (/email/.test(conflictText)) code = 'CONFLICT_EMAIL';
        else if (/felhasználónév|username/.test(conflictText)) code = 'CONFLICT_USERNAME';
        else code = 'CONFLICT';
      } else if (response.status === 429) {
        code = 'RATE_LIMITED';
      } else if (response.status === 413) {
        code = 'PAYLOAD_TOO_LARGE';
      } else if (response.status >= 500) {
        code = 'SERVER_ERROR';
      }

      throw new ApiError(
        response.status,
        msg,
        data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined,
        code,
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw toNetworkApiError(error);
  }
}


export const authApi = {
  register: (data: { username: string; email: string; password: string; acceptedTerms: true }) =>
    request<{ user: unknown }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (email: string, password: string) =>
    request<{ accessToken: string; refreshToken: string; user: UserDto }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: (refreshToken: string) =>
    request('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
};

interface UserDto {
  id: string;
  username: string;
  email: string;
  role: string;
}

export const statsApi = {
  today: () => request<any>('/stats/today'),
  day: (date: string) => request<any>(`/stats/day?date=${date}`),
  weekly: (opts?: { weekStart?: string; weeksBack?: number }) => {
    const p = new URLSearchParams();
    if (opts?.weekStart) p.set('weekStart', opts.weekStart);
    if (opts?.weeksBack != null) p.set('weeksBack', String(opts.weeksBack));
    const q = p.toString();
    return request<WeeklyStatsResult>(`/stats/weekly${q ? `?${q}` : ''}`);
  },
  monthly: (year: number, month: number) => request<any>(`/stats/monthly?year=${year}&month=${month}`),
  loggedDays: (year: number, month: number) =>
    request<{
      year: number;
      month: number;
      dailyKcalGoal: number;
      dates: string[];
      days: { date: string; kcal: number }[];
    }>(`/stats/logged-days?year=${year}&month=${month}`),
  streak: () => request<{ streak: number; message: string }>('/stats/streak'),
};

export type WeeklyDayStats = {
  date: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  logCount: number;
};

export type WeeklyStatsSummary = {
  avgKcal: number;
  avgProtein: number;
  avgCarbs: number;
  avgFat: number;
  totalKcal: number;
  loggedDays: number;
  emptyDays?: number;
  daysOnTarget: number;
  avgDeltaVsGoal: number;
  highestDay: { date: string; kcal: number } | null;
  lowestDay: { date: string; kcal: number } | null;
  kcalRange: number | null;
  mostLoggedDay: { date: string; logCount: number } | null;
  bestDayVsGoal?: { date: string; kcal: number; delta: number } | null;
  worstDayVsGoal?: { date: string; kcal: number; delta: number } | null;
  macroAdherence?: {
    protein: number | null;
    carbs: number | null;
    fat: number | null;
  };
  dominantMeal?: { mealType: string; avgKcal: number; sharePct: number } | null;
  prevWeek?: {
    avgKcal: number;
    loggedDays: number;
    avgDeltaVsGoal: number;
    avgProtein: number;
    avgCarbs: number;
    avgFat: number;
    deltaAvgKcal: number;
  };
  body?: {
    weightDeltaKg: number | null;
    firstWeightKg: number | null;
    lastWeightKg: number | null;
    firstWeightDate: string | null;
    lastWeightDate: string | null;
    measurements: Array<{
      bodyPart: string;
      firstCm: number;
      lastCm: number;
      deltaCm: number;
      firstDate?: string | null;
      lastDate?: string | null;
    }>;
  } | null;
};

export type WeeklyStatsResult = {
  days: WeeklyDayStats[];
  avg: { kcal: number; protein: number; carbs: number; fat: number };
  mealAvg: Record<
    string,
    { kcal: number; protein: number; carbs: number; fat: number; daysWithMeal: number }
  >;
  mealDaily?: Record<
    string,
    Array<{ date: string; kcal: number; protein?: number; carbs?: number; fat?: number }>
  >;
  weightDaily?: Array<{ date: string; weightKg: number | null }>;
  from: string;
  to: string;
  goals?: {
    dailyKcalGoal: number;
    dailyProteinGoal: number;
    dailyCarbsGoal: number;
    dailyFatGoal: number;
    goal: string | null;
  };
  summary?: WeeklyStatsSummary;
};

export type FoodStatus = 'UNVERIFIED' | 'VERIFIED' | 'BANNED';

export type FoodOrigin = 'local' | 'off' | 'usda' | 'external';

export interface FoodComponent {
  id?: string;
  name: string;
  amountG: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number | null;
  sugar?: number | null;
  sortOrder?: number;
}

export interface Food {
  id: string;
  name: string;
  nameHu?: string;
  nameEn?: string;
  displayName?: string;
  brand?: string;
  barcode?: string;
  externalId?: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  servingSize?: number;
  servingUnit?: string;
  isPrepared?: boolean;
  components?: FoodComponent[];
  status: FoodStatus;
  tier: 'FREE' | 'PREMIUM';
  score?: number;
  myVote?: 1 | -1 | null;
  source?: 'INTERNAL' | 'USER_SCAN' | 'EXTERNAL_API' | 'MANUAL' | 'SCAN' | 'SEARCH';
  origin?: FoodOrigin;
  isFavorite?: boolean;
  creator?: { username: string; reputation: number };
  _count?: { votes: number };
}

export const foodApi = {
  search: (q: string, opts?: { limit?: number; offset?: number; mine?: boolean; scope?: string }) => {
    const p = new URLSearchParams({ q, limit: String(opts?.limit ?? 20), offset: String(opts?.offset ?? 0) });
    if (opts?.mine) p.set('mine', '1');
    if (opts?.scope) p.set('scope', opts.scope);
    return request<{ foods: Food[]; total: number }>(`/foods?${p}`);
  },
  recent: (limit = 20) =>
    request<{ foods: Food[]; total: number }>(`/foods/recent?limit=${limit}`),
  frequent: (limit = 20) =>
    request<{ foods: Food[]; total: number }>(`/foods/frequent?limit=${limit}`),
  favorites: (limit = 50) =>
    request<{ foods: Food[]; total: number }>(`/foods/favorites?limit=${limit}`),
  addFavorite: (id: string) =>
    request<{ isFavorite: boolean }>(`/foods/${id}/favorite`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  removeFavorite: (id: string) =>
    request<{ isFavorite: boolean }>(`/foods/${id}/favorite`, { method: 'DELETE' }),
  getById: (id: string) => request<Food & { score: number; myVote: 1 | -1 | null }>(`/foods/${id}`),
  getByBarcode: (barcode: string) => request<Food & { source: string }>(`/foods/barcode/${barcode}`),
  create: (data: unknown) => request<Food>('/foods', { method: 'POST', body: JSON.stringify(data) }),
  aiRecognize: (data: {
    mode: 'photo' | 'text';
    text?: string;
    imageBase64?: string;
    mimeType?: string;
    locale?: 'hu' | 'en';
  }) =>
    request<{
      dishName: string;
      ingredients: Array<{
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
      }>;
      remaining: number;
      limit: number;
    }>('/foods/ai-recognize', {
      method: 'POST',
      body: JSON.stringify(data),
      // Fail with our own message before a proxy/tunnel answers with an HTML 502.
      ...requestTimeout(70_000),
    }),
  aiServingEstimate: (data: {
    name: string;
    brand?: string;
    unit: 'db' | 'adag' | 'ek' | 'szelet';
    locale?: 'hu' | 'en';
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber?: number;
    sugar?: number;
  }) =>
    request<{
      gramsPerUnit: number;
      remaining: number;
      limit: number;
    }>('/foods/ai-serving-estimate', { method: 'POST', body: JSON.stringify(data) }),
  aiLabelFill: (data: {
    imageBase64: string;
    mimeType?: string;
    locale?: 'hu' | 'en';
  }) =>
    request<{
      name: string;
      brand?: string;
      barcode?: string;
      kcal: number;
      protein: number;
      carbs: number;
      fat: number;
      fiber?: number;
      sugar?: number;
      isApproximate: boolean;
      approximateNote?: string;
      remaining: number;
      limit: number;
    }>('/foods/ai-label-fill', {
      method: 'POST',
      body: JSON.stringify(data),
      ...requestTimeout(70_000),
    }),
  update: (id: string, data: Partial<Food> | Record<string, unknown>) =>
    request<Food>(`/foods/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  editHistory: (id: string) =>
    request<{ edits: Array<{ id: string; username: string; createdAt: string }> }>(
      `/foods/${id}/edits`,
    ),
  vote: (foodId: string, value: 1 | -1) =>
    request<{
      action: 'added' | 'removed' | 'changed';
      score: number;
      status?: FoodStatus;
      myVote?: 1 | -1 | null;
      earnedExpertBadge?: boolean;
    }>(`/foods/${foodId}/vote`, { method: 'POST', body: JSON.stringify({ value }) }),
};
export type MealDaySummary = {
  date: string;
  mealType: string;
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  previewNames: string[];
  itemCount: number;
};

export type MealSlotHistory = {
  yesterday: MealDaySummary | null;
  lastFilled: MealDaySummary | null;
  days: MealDaySummary[];
  frequent: (MealDaySummary & { times: number }) | null;
};

export type MealHistoryResult = {
  before: string;
  days: number;
  slots: Partial<Record<string, MealSlotHistory>>;
};

export type CopyLogsBody = {
  date: string;
  mealType: string;
  sourceDate?: string;
  sourceMealType?: string;
  templateId?: string;
  copyAll?: boolean;
  items?: { type: 'log' | 'group'; id: string }[];
};

export type CopyLogsResult = {
  logs: unknown[];
  logIds: string[];
  groupIds: string[];
};

export type MealTemplateItem = {
  id: string;
  foodId: string | null;
  foodName: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sugar: number | null;
  amount: number;
  sortOrder: number;
  groupKey: string | null;
  groupName?: string | null;
  sourcePreparedFoodId: string | null;
  sourcePreparedFoodName: string | null;
};

export type MealTemplate = {
  id: string;
  name: string;
  mealType: string;
  createdAt: string;
  updatedAt: string;
  totals: { kcal: number; protein: number; carbs: number; fat: number };
  previewNames: string[];
  itemCount: number;
  items: MealTemplateItem[];
};

export const logApi = {
  getToday: () => {
    const today = new Date().toISOString().split('T')[0];
    return request<any>(`/logs?date=${today}`);
  },
  getByDate: (date: string, mealType?: string) =>
    request<any>(`/logs?date=${date}${mealType ? `&mealType=${mealType}` : ''}`),
  getRange: (from: string, to: string) => request<any>(`/logs?from=${from}&to=${to}`),
  mealHistory: (opts: { before: string; days?: number; mealType?: string }) => {
    const q = new URLSearchParams({ before: opts.before });
    if (opts.days != null) q.set('days', String(opts.days));
    if (opts.mealType) q.set('mealType', opts.mealType);
    return request<MealHistoryResult>(`/logs/meal-history?${q.toString()}`);
  },
  copy: (data: CopyLogsBody) =>
    request<CopyLogsResult>('/logs/copy', { method: 'POST', body: JSON.stringify(data) }),
  templates: (mealType?: string) =>
    request<{ templates: MealTemplate[] }>(
      `/logs/templates${mealType ? `?mealType=${mealType}` : ''}`,
    ),
  createTemplate: (data: {
    name: string;
    mealType: string;
    sourceDate: string;
    sourceMealType: string;
    copyAll?: boolean;
    items?: { type: 'log' | 'group'; id: string }[];
  }) => request<MealTemplate>('/logs/templates', { method: 'POST', body: JSON.stringify(data) }),
  deleteTemplate: (id: string) => request<{ message: string }>(`/logs/templates/${id}`, { method: 'DELETE' }),
  create: (data: unknown) => request('/logs', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: unknown) =>
    request(`/logs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/logs/${id}`, { method: 'DELETE' }),
  deleteGroup: (logGroupId: string) =>
    request(`/logs/group/${logGroupId}`, { method: 'DELETE' }),
};

export type DailyAnalysisResult = {
  date: string;
  content: string | null;
  generationCount: number;
  remaining: number;
  max?: number;
  updatedAt: string | null;
};

export type AnalysisKind = 'nutrition' | 'fitness' | 'coach' | 'mealSuggest' | 'weeklyNutrition';

export const analysisApi = {
  get: (date: string, kind: AnalysisKind = 'nutrition') =>
    request<DailyAnalysisResult>(`/analysis?date=${date}&kind=${kind}`),
  generate: (
    date: string,
    locale?: 'hu' | 'en',
    kind: AnalysisKind = 'nutrition',
    mealType?: string,
    opts?: { force?: boolean },
  ) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const oh = pad(Math.floor(Math.abs(offMin) / 60));
    const om = pad(Math.abs(offMin) % 60);
    const localTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
    return request<DailyAnalysisResult>('/analysis', {
      method: 'POST',
      body: JSON.stringify({
        date,
        localTime,
        kind,
        ...(locale ? { locale } : {}),
        ...(mealType ? { mealType } : {}),
        ...(opts?.force ? { force: true } : {}),
      }),
    });
  },
};

export const waterApi = {
  getToday: () =>
    request<{ logs: any[]; log: any | null; totalMl: number; goalMl: number }>('/water/today'),
  getByDate: (date: string) =>
    request<{ logs: any[]; log: any | null; totalMl: number; goalMl: number }>(`/water?date=${date}`),
  /** Napi total módosítása (pozitív = hozzáadás, negatív = levonás). */
  adjust: (deltaMl: number, date?: string) =>
    request<{ logs: any[]; log: any | null; totalMl: number; goalMl: number }>('/water', {
      method: 'POST',
      body: JSON.stringify({ deltaMl, ...(date ? { date } : {}) }),
    }),
  /** Legacy: pozitív hozzáadás. */
  add: (amountMl: number, date?: string) =>
    request<{ logs: any[]; log: any | null; totalMl: number; goalMl: number }>('/water', {
      method: 'POST',
      body: JSON.stringify({ amountMl, ...(date ? { date } : {}) }),
    }),
  setForDate: (date: string, totalMl: number) =>
    request<{ logs: any[]; log: any | null; totalMl: number; goalMl: number }>('/water', {
      method: 'POST',
      body: JSON.stringify({ date, totalMl }),
    }),
  history: (range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    const qs = params.toString();
    return request<{
      latest: {
        id: string;
        totalMl: number;
        loggedDate: string;
        updatedAt: string;
        deltaMl: number | null;
      } | null;
      items: Array<{
        id: string;
        totalMl: number;
        loggedDate: string;
        updatedAt: string;
        deltaMl: number | null;
      }>;
      goalMl: number;
    }>(`/water/history${qs ? `?${qs}` : ''}`);
  },
  update: (id: string, data: { totalMl?: number; date?: string }) =>
    request(`/water/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/water/${id}`, { method: 'DELETE' }),
};

export type FastingProtocol = '16:8' | '18:6' | '20:4' | 'OMAD' | 'CUSTOM';
export type FastingSource = 'MANUAL' | 'FROM_LAST_MEAL';

export type FastSessionDto = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  goalMinutes: number;
  protocol: string;
  source: string;
  elapsedMinutes: number;
  eatingWindowMinutes: number;
};

export type FastingCurrent = {
  active: FastSessionDto | null;
  lastEnded: FastSessionDto | null;
  eatingUntil: string | null;
  lastMealAt: string | null;
  protocol: string;
  goalMinutes: number;
};

export type FastingHistory = {
  items: FastSessionDto[];
  latest: FastSessionDto | null;
  goalMinutes: number;
};

export const fastingApi = {
  current: () => request<FastingCurrent>('/fasting/current'),
  start: (data?: { protocol?: FastingProtocol; goalMinutes?: number; source?: FastingSource }) =>
    request<{ session: FastSessionDto }>('/fasting/start', {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),
  stop: () =>
    request<{ session: FastSessionDto; eatingUntil: string }>('/fasting/stop', { method: 'POST' }),
  setGoal: (data: { protocol?: FastingProtocol; goalMinutes?: number }) =>
    request<FastingCurrent>('/fasting/goal', { method: 'PUT', body: JSON.stringify(data) }),
  history: (from?: string, to?: string, limit?: number) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (limit != null) p.set('limit', String(limit));
    const q = p.toString();
    return request<FastingHistory>(`/fasting/history${q ? `?${q}` : ''}`);
  },
  delete: (id: string) => request<{ ok: boolean }>(`/fasting/${id}`, { method: 'DELETE' }),
};

export type DayNote = {
  id: string;
  content: string;
  loggedDate: string;
  updatedAt: string;
};

export const dayNoteApi = {
  getByDate: (date: string) =>
    request<{ note: DayNote | null }>(`/day-notes?date=${encodeURIComponent(date)}`),
  save: (date: string, content: string) =>
    request<{ note: DayNote | null }>('/day-notes', {
      method: 'PUT',
      body: JSON.stringify({ date, content }),
    }),
};

export const weightApi = {
  getByDate: (date: string) =>
    request<{
      log: {
        id: string;
        weightKg: number;
        loggedDate: string;
        updatedAt: string;
      } | null;
      weightKg: number | null;
      suggestedWeightKg: number | null;
      deltaKg: number | null;
      lastMeasuredAt: string | null;
    }>(`/weight?date=${date}`),
  setForDate: (date: string, weightKg: number) =>
    request<{
      log: {
        id: string;
        weightKg: number;
        loggedDate: string;
        updatedAt: string;
      } | null;
      weightKg: number | null;
      suggestedWeightKg: number | null;
      deltaKg: number | null;
      lastMeasuredAt: string | null;
    }>('/weight', { method: 'POST', body: JSON.stringify({ date, weightKg }) }),
  history: (range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    const qs = params.toString();
    return request<{
      latest: {
        id: string;
        weightKg: number;
        loggedDate: string;
        updatedAt: string;
        deltaKg: number | null;
      } | null;
      items: Array<{
        id: string;
        weightKg: number;
        loggedDate: string;
        updatedAt: string;
        deltaKg: number | null;
      }>;
      monthlyChangeKg: number | null;
      targetWeightKg: number | null;
    }>(`/weight/history${qs ? `?${qs}` : ''}`);
  },
  update: (id: string, data: { weightKg?: number; date?: string }) =>
    request(`/weight/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/weight/${id}`, { method: 'DELETE' }),
};

export type BodyPart = 'ARM' | 'THIGH' | 'WAIST' | 'FOREARM' | 'HIP' | 'CHEST' | 'CALF';

export type BodyAnalysisContent = {
  headline: string;
  summary: string;
  positives: string[];
  concerns: string[];
  suggestions: string[];
};

export const bodyApi = {
  summary: () =>
    request<{
      parts: Array<{ bodyPart: BodyPart; valueCm: number | null; loggedDate: string | null }>;
      goals: Array<{ bodyPart: BodyPart; goalCm: number }>;
      fat: { fatPercent: number; loggedDate: string } | null;
    }>('/body/summary'),
  create: (data: { bodyPart: BodyPart; valueCm: number; date: string }) =>
    request('/body', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { valueCm?: number; date?: string }) =>
    request(`/body/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/body/${id}`, { method: 'DELETE' }),
  history: (bodyPart: BodyPart, range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams({ bodyPart });
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    return request<{
      bodyPart: BodyPart;
      latest: {
        id: string;
        valueCm: number;
        loggedDate: string;
        updatedAt: string;
        deltaCm: number | null;
      } | null;
      items: Array<{
        id: string;
        valueCm: number;
        loggedDate: string;
        updatedAt: string;
        deltaCm: number | null;
      }>;
      monthlyChangeCm: number | null;
      goalCm: number | null;
    }>(`/body/history?${params.toString()}`);
  },
  getGoals: () =>
    request<{ goals: Array<{ bodyPart: BodyPart; goalCm: number }> }>('/body/goals'),
  setGoals: (goals: Array<{ bodyPart: BodyPart; goalCm: number }>) =>
    request<{ goals: Array<{ bodyPart: BodyPart; goalCm: number }> }>('/body/goals', {
      method: 'PUT',
      body: JSON.stringify({ goals }),
    }),
  getAnalysis: () =>
    request<{
      content: string | null;
      generationCount: number;
      remaining: number;
      limit: number;
      updatedAt: string | null;
    }>('/body/analysis'),
  generateAnalysis: (locale?: 'hu' | 'en') =>
    request<{
      content: string;
      analysis: BodyAnalysisContent;
      generationCount: number;
      remaining: number;
      limit: number;
      updatedAt: string;
    }>('/body/analysis', {
      method: 'POST',
      body: JSON.stringify(locale ? { locale } : {}),
    }),
};

export const bodyFatApi = {
  history: (range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    const qs = params.toString();
    return request<{
      latest: {
        id: string;
        fatPercent: number;
        loggedDate: string;
        updatedAt: string;
        deltaPercent: number | null;
      } | null;
      items: Array<{
        id: string;
        fatPercent: number;
        loggedDate: string;
        updatedAt: string;
        deltaPercent: number | null;
      }>;
      monthlyChangePercent: number | null;
      goalPercent: number | null;
    }>(`/body/fat/history${qs ? `?${qs}` : ''}`);
  },
  create: (data: { fatPercent: number; date: string }) =>
    request('/body/fat', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { fatPercent?: number; date?: string }) =>
    request(`/body/fat/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/body/fat/${id}`, { method: 'DELETE' }),
  setGoal: (goalPercent: number) =>
    request<{ goalPercent: number }>('/body/fat/goal', {
      method: 'PUT',
      body: JSON.stringify({ goalPercent }),
    }),
};

export type FitnessHrPoint = { tMs: number; bpm: number };

export type FitnessWorkout = {
  id: string;
  activityType: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMin: number;
  activeEnergyKcal: number | null;
  distanceKm: number | null;
  steps: number | null;
  avgHeartrate: number | null;
  minHeartrate: number | null;
  maxHeartrate: number | null;
  restingHeartrate: number | null;
  pace: number | null;
  speedAvg: number | null;
  speedMax: number | null;
  elevationGain: number | null;
  elevationMin: number | null;
  elevationMax: number | null;
  floorsClimbed: number | null;
  vo2Max: number | null;
  respiratoryRate: number | null;
  mindfulMinutes: number | null;
  avgStressLevel: number | null;
  providerType: string | null;
  hrSeries: FitnessHrPoint[] | null;
  source: 'SHORTCUTS' | 'MANUAL' | 'FITNESSSYNCER';
  externalId: string | null;
  createdAt: string;
};

export type FitnessSyncerStatus = {
  status: 'DISCONNECTED' | 'CONNECTED' | 'ERROR';
  hasCredentials: boolean;
  hasClientId: boolean;
  connected: boolean;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  callbackUrl: string | null;
  oauthPending?: boolean;
  needsSync: boolean;
  cryptoConfigured: boolean;
};

export const fitnessApi = {
  getFsStatus: () => request<FitnessSyncerStatus>('/fitness/fitnesssyncer/status'),
  saveFsCredentials: (clientId: string, clientSecret: string) =>
    request<FitnessSyncerStatus>('/fitness/fitnesssyncer/credentials', {
      method: 'PUT',
      body: JSON.stringify({ clientId, clientSecret }),
    }),
  startFsConnect: () =>
    request<{ authorizeUrl: string; callbackUrl: string; hint?: string }>(
      '/fitness/fitnesssyncer/connect',
    ),
  exchangeFsPaste: (pasted: string) =>
    request<FitnessSyncerStatus>('/fitness/fitnesssyncer/exchange', {
      method: 'POST',
      body: JSON.stringify({ pasted }),
    }),
  disconnectFs: () => request<FitnessSyncerStatus>('/fitness/fitnesssyncer', { method: 'DELETE' }),
  sync: (days?: number) =>
    request<{
      ok: boolean;
      sources: number;
      workoutsUpserted: number;
      stepsUpserted: number;
      days: number;
      lastSyncAt: string;
    }>('/fitness/sync', {
      method: 'POST',
      body: JSON.stringify(days != null ? { days } : {}),
    }),
  listWorkouts: (date: string) =>
    request<{ date: string; workouts: FitnessWorkout[] }>(`/fitness/workouts?date=${date}`),
  getWorkout: (id: string) =>
    request<{ workout: FitnessWorkout }>(`/fitness/workouts/${id}`),
  createWorkout: (data: {
    activityType: string;
    startedAt: string;
    endedAt?: string | null;
    durationMin: number;
    activeEnergyKcal?: number | null;
    distanceKm?: number | null;
  }) =>
    request<{ workout: FitnessWorkout }>('/fitness/workouts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteWorkout: (id: string) =>
    request<{ ok: boolean }>(`/fitness/workouts/${id}`, { method: 'DELETE' }),
  getSteps: (date: string) =>
    request<{
      date: string;
      steps: number | null;
      source: 'SHORTCUTS' | 'MANUAL' | 'FITNESSSYNCER' | null;
      updatedAt: string | null;
    }>(`/fitness/steps?date=${date}`),
  putSteps: (date: string, steps: number) =>
    request<{
      date: string;
      steps: number;
      source: 'SHORTCUTS' | 'MANUAL' | 'FITNESSSYNCER';
      updatedAt: string;
    }>('/fitness/steps', {
      method: 'PUT',
      body: JSON.stringify({ date, steps }),
    }),
};

export type GoalSnapshot = {
  dailyKcalGoal: number;
  dailyProteinGoal: number;
  dailyCarbsGoal: number;
  dailyFatGoal: number;
  dailyWaterGoalMl: number;
};

export type KcalGoalSuggestion = {
  show: boolean;
  reason?: 'disabled' | 'insufficient_logs' | 'below_threshold' | 'dismissed' | 'missing_profile';
  weekKey: string;
  trendWeightKg: number | null;
  startWeightKg: number | null;
  current: GoalSnapshot | null;
  suggested: GoalSnapshot | null;
  deltaKcal: number | null;
  deltaProtein: number | null;
  reachedTarget: boolean;
};

export const profileApi = {
  getMe: () => request<any>('/profile/me'),
  update: (data: unknown) => request('/profile', { method: 'PUT', body: JSON.stringify(data) }),
  aiCalculateGoals: (data?: {
    goal?: 'LOSE' | 'MAINTAIN' | 'GAIN';
    targetWeightKg?: number | null;
    goalWeeks?: number | null;
    locale?: 'hu' | 'en';
  }) =>
    request<{ profile: any; goals: any }>('/profile/ai-calculate-goals', {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),
  getKcalGoalSuggestion: () => request<KcalGoalSuggestion>('/profile/kcal-goal-suggestion'),
  applyKcalGoalSuggestion: () =>
    request<KcalGoalSuggestion>('/profile/kcal-goal-suggestion/apply', { method: 'POST' }),
  dismissKcalGoalSuggestion: () =>
    request<{ weekKey: string }>('/profile/kcal-goal-suggestion/dismiss', { method: 'POST' }),
};

export const premiumApi = {
  getStatus: () => request<any>('/premium/status'),
  getFeatures: () => request<any>('/premium/features'),
  devUpgrade: () => request('/premium/upgrade', { method: 'POST' }),
  devDowngrade: () => request('/premium/downgrade', { method: 'POST' }),
};

export const exportApi = {
  preview: (from?: string, to?: string) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return request<{
      from: string;
      to: string;
      days: number;
      logCount: number;
      waterCount: number;
      weightCount?: number;
      bodyCount?: number;
      fatCount?: number;
      sheets: string[];
    }>(`/export/preview?${p}`);
  },
  getDownloadUrl: (from?: string, to?: string) => {
    const base = API_BASE;
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return `${base}/export?${p}`;
  },
};

export const adminApi = {
  getDashboard: () =>
    request<{
      stats: {
        totalUsers: number;
        newUsersToday: number;
        totalFoods: number;
        pendingFoods: number;
        pendingRecipes?: number;
        bannedFoods: number;
        totalLogs: number;
        logsToday: number;
        premiumUsers: number;
      };
      topContributors: { id: string; username: string; reputation: number; role: string }[];
    }>('/admin/dashboard'),
  getFoods: (opts?: { status?: string; q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set('status', opts.status);
    if (opts?.q) p.set('q', opts.q);
    if (opts?.limit) p.set('limit', String(opts.limit));
    if (opts?.offset) p.set('offset', String(opts.offset));
    return request<{ foods: any[]; total: number }>(`/admin/foods?${p}`);
  },
  deleteFood: (id: string) => request(`/admin/foods/${id}`, { method: 'DELETE' }),
  setFoodStatus: (id: string, status: 'UNVERIFIED' | 'VERIFIED' | 'BANNED') =>
    request(`/admin/foods/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  getUsers: (opts?: { q?: string; role?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.q) p.set('q', opts.q);
    if (opts?.role) p.set('role', opts.role);
    if (opts?.limit) p.set('limit', String(opts.limit));
    if (opts?.offset) p.set('offset', String(opts.offset));
    return request<{ users: any[]; total: number }>(`/admin/users?${p}`);
  },
  setUserRole: (id: string, role: 'USER' | 'ADMIN') =>
    request(`/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  setUserTier: (id: string, tier: 'FREE' | 'PREMIUM') =>
    request(`/admin/users/${id}/tier`, { method: 'PATCH', body: JSON.stringify({ tier }) }),
  softDeleteUser: (id: string) => request(`/admin/users/${id}`, { method: 'DELETE' }),
  adjustReputation: (id: string, delta: number, reason?: string) =>
    request(`/admin/users/${id}/reputation`, { method: 'PATCH', body: JSON.stringify({ delta, reason }) }),
  getBadges: () => request<{ experts: any[]; threshold: number; total: number }>('/admin/badges'),
  getRecipes: (opts?: { status?: string; page?: number; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set('status', opts.status);
    if (opts?.page) p.set('page', String(opts.page));
    if (opts?.limit) p.set('limit', String(opts.limit));
    return request<{
      recipes: Array<{
        id: string;
        title: string;
        status: string;
        sourceType: string;
        createdAt: string;
        createdBy: { id: string; username: string };
        hasImage: boolean;
        imageRevision?: string | null;
      }>;
      total: number;
    }>(`/admin/recipes?${p}`);
  },
  approveRecipe: (id: string) => request(`/admin/recipes/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }),
  rejectRecipe: (id: string, reason?: string) =>
    request(`/admin/recipes/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
};

export type RecipeCategory = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK' | 'DESSERT' | 'OTHER';
export type RecipeDietTag = 'GLUTEN_FREE' | 'DAIRY_FREE' | 'VEGAN';
export type RecipeSourceType =
  | 'MANUAL'
  | 'IMAGE'
  | 'VIDEO'
  | 'FACEBOOK'
  | 'INSTAGRAM'
  | 'TIKTOK'
  | 'YOUTUBE'
  | 'WEB';

export type RecipeNutrition = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  gramsPerServing?: number;
  incomplete: boolean;
  matchedCount: number;
  totalCount: number;
};

export type RecipeIngredientDraft = {
  id?: string;
  name: string;
  amount?: number | null;
  unit?: string | null;
  amountG?: number | null;
  sortOrder?: number;
  foodId?: string | null;
  matchConfidence?: number | null;
  matchedFoodName?: string | null;
  suggestedFood?: { id: string; displayName: string } | null;
};

export type RecipeDraft = {
  title: string;
  description?: string | null;
  servings: number;
  category?: RecipeCategory | null;
  dietTags?: RecipeDietTag[];
  ingredients: RecipeIngredientDraft[];
  instructions: string[];
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  sourceType: RecipeSourceType;
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  effort?: 'QUICK' | 'NORMAL' | 'PROJECT' | null;
  seasonMonths?: number[];
  leftoverDays?: number;
};

export type RecipeListItem = {
  id: string;
  title: string;
  servings: number;
  category: RecipeCategory | null;
  dietTags?: RecipeDietTag[];
  status: string;
  sourceType: RecipeSourceType;
  createdAt: string;
  createdBy: { id: string; username: string };
  hasImage: boolean;
  imageRevision?: string | null;
  isFavorite: boolean;
  nutrition?: RecipeNutrition | null;
};

export type RecipeDetail = RecipeDraft & {
  id: string;
  status: string;
  rejectReason?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; username: string };
  hasImage: boolean;
  imageRevision?: string | null;
  isFavorite: boolean;
  isOwner: boolean;
  nutrition?: RecipeNutrition | null;
};

async function requestBlob(path: string, retry = true): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${API_BASE}${path}`, { headers, cache: 'no-store' });
  if (response.status === 401 && retry) {
    const refreshed = await refreshAccessTokenFromStorage();
    if (refreshed) return requestBlob(path, false);
    throw new ApiError(401, 'A hitelesítés frissítése sikertelen. Próbáld újra később.');
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'A kép betöltése sikertelen.');
  }
  return response.blob();
}

export const recipesApi = {
  list: (opts?: {
    page?: number;
    limit?: number;
    search?: string;
    category?: RecipeCategory;
    favorite?: boolean;
    dietTags?: RecipeDietTag[];
  }) => {
    const p = new URLSearchParams();
    if (opts?.page) p.set('page', String(opts.page));
    if (opts?.limit) p.set('limit', String(opts.limit));
    if (opts?.search) p.set('search', opts.search);
    if (opts?.category) p.set('category', opts.category);
    if (opts?.favorite) p.set('favorite', 'true');
    if (opts?.dietTags?.length) p.set('diet', opts.dietTags.join(','));
    const q = p.toString();
    return request<{ recipes: RecipeListItem[]; page: number; limit: number; total: number }>(
      `/recipes${q ? `?${q}` : ''}`,
    );
  },
  get: (id: string) => request<RecipeDetail>(`/recipes/${id}`),
  create: (data: RecipeDraft & { tempImageKey?: string; sourceExternalId?: string | null }) =>
    request<RecipeDetail>('/recipes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<RecipeDraft> & { tempImageKey?: string }) =>
    request<RecipeDetail>(`/recipes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: string) => request(`/recipes/${id}`, { method: 'DELETE' }),
  favorite: (id: string) => request<{ isFavorite: boolean }>(`/recipes/${id}/favorite`, { method: 'POST' }),
  unfavorite: (id: string) => request<{ isFavorite: boolean }>(`/recipes/${id}/favorite`, { method: 'DELETE' }),
  match: (ingredients: RecipeIngredientDraft[], servings = 1) =>
    request<{ ingredients: RecipeIngredientDraft[]; nutrition: RecipeNutrition | null }>('/recipes/match', {
      method: 'POST',
      body: JSON.stringify({ ingredients, servings }),
    }),
  log: (id: string, data: { servings?: number; amountG?: number; mealType: string; date?: string }) =>
    request(`/recipes/${id}/log`, { method: 'POST', body: JSON.stringify(data) }),
  importFromImage: (file: File, locale: 'hu' | 'en' = 'hu') => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{
      draft: RecipeDraft;
      nutrition?: RecipeNutrition | null;
      tempImageKey: string;
      remaining: number;
      limit: number;
    }>(`/recipes/import/image?locale=${locale}`, { method: 'POST', body: fd });
  },
  importFromUrl: (url: string, locale: 'hu' | 'en' = 'hu') =>
    request<{
      draft: RecipeDraft;
      nutrition?: RecipeNutrition | null;
      tempImageKey?: string;
      needsFallback?: boolean;
      remaining: number;
      limit: number;
    }>('/recipes/import/url', { method: 'POST', body: JSON.stringify({ url, locale }) }),
  importFromVideo: (file: File, locale: 'hu' | 'en' = 'hu') => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{
      draft: RecipeDraft;
      nutrition?: RecipeNutrition | null;
      remaining: number;
      limit: number;
    }>(`/recipes/import/video?locale=${locale}`, {
      method: 'POST',
      body: fd,
      ...requestTimeout(180_000),
    });
  },
  getImageBlob: (id: string, revision?: number | string | null) =>
    requestBlob(
      `/recipes/${id}/image${revision != null && revision !== '' ? `?v=${encodeURIComponent(String(revision))}` : ''}`,
    ),
  getTempImageBlob: (key: string) => requestBlob(`/recipes/tmp/${key}/image`),
  uploadImage: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ ok: boolean; imageRevision?: string }>(`/recipes/${id}/images`, { method: 'POST', body: fd });
  },
  uploadTempImage: (file: File, replaceKey?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    const q = replaceKey ? `?replace=${encodeURIComponent(replaceKey)}` : '';
    return request<{ tempImageKey: string }>(`/recipes/tmp/image${q}`, { method: 'POST', body: fd });
  },
};

export type MealPlanSlotSource = 'RECIPE' | 'TEMPLATE' | 'FOOD' | 'SKIPPED';
export type MealPlanMealType =
  | 'BREAKFAST'
  | 'TIZORAI'
  | 'LUNCH'
  | 'UZSONNA'
  | 'DINNER'
  | 'SNACK'
  | 'OTHER';

export type MealPlanSlot = {
  id: string;
  slotDate: string;
  mealType: MealPlanMealType;
  source: MealPlanSlotSource;
  recipeId: string | null;
  templateId: string | null;
  foodId: string | null;
  servings: number;
  amountG: number | null;
  title: string | null;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  loggable: boolean;
  logged: boolean;
  hasImage: boolean;
  imageRevision: string | null;
};

export type MealPlanSwitcher = {
  ownerId: string;
  username: string;
  isOwn: boolean;
  shareId: string | null;
};

export type MealPlanWeek = {
  weekStart: string;
  weekEnd: string;
  owner: { id: string; username: string };
  isOwn: boolean;
  plans: MealPlanSwitcher[];
  slots: MealPlanSlot[];
  generate?: { used: number; limit: number; remaining: number };
};

export type PantryItem = {
  id: string;
  foodId: string | null;
  name: string;
  quantity: number;
  unit: string;
  qtyLabel: string;
  expiresOn: string | null;
  source: string;
  macros?: { kcal: number; protein: number; carbs: number; fat: number } | null;
};

export const mealPlanApi = {
  get: (opts?: { weekStart?: string; ownerId?: string }) => {
    const p = new URLSearchParams();
    if (opts?.weekStart) p.set('weekStart', opts.weekStart);
    if (opts?.ownerId) p.set('ownerId', opts.ownerId);
    const q = p.toString();
    return request<MealPlanWeek>(`/meal-plan${q ? `?${q}` : ''}`);
  },
  upsertSlot: (data: {
    weekStart?: string;
    ownerId?: string;
    slotDate: string;
    mealType: string;
    source: MealPlanSlotSource;
    recipeId?: string | null;
    templateId?: string | null;
    foodId?: string | null;
    servings?: number;
    amountG?: number | null;
  }) => request<{ slot: MealPlanSlot }>('/meal-plan/slots', { method: 'PUT', body: JSON.stringify(data) }),
  deleteSlot: (id: string, alsoDiary = false) =>
    request<{ ok: boolean }>(`/meal-plan/slots/${id}${alsoDiary ? '?alsoDiary=true' : ''}`, { method: 'DELETE' }),
  deleteDay: (date: string, opts?: { alsoDiary?: boolean; ownerId?: string }) => {
    const p = new URLSearchParams();
    if (opts?.alsoDiary) p.set('alsoDiary', 'true');
    if (opts?.ownerId) p.set('ownerId', opts.ownerId);
    const q = p.toString();
    return request<{ ok: boolean; deleted: number }>(`/meal-plan/days/${date}${q ? `?${q}` : ''}`, {
      method: 'DELETE',
    });
  },
  logSlot: (id: string, data?: { servings?: number; amountG?: number; date?: string; deductPantry?: boolean }) =>
    request<{ ok: boolean; alreadyLogged: boolean; slot: MealPlanSlot }>(`/meal-plan/slots/${id}/log`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),
  generate: (data?: {
    weekStart?: string;
    ownerId?: string;
    meals?: Array<'BREAKFAST' | 'LUNCH' | 'DINNER'>;
    usePantry?: boolean;
    seasonal?: boolean;
    scope?: 'day' | 'week';
    date?: string;
    diet?: Array<'GLUTEN_FREE' | 'DAIRY_FREE' | 'VEGAN' | 'SUGAR_FREE'>;
    matchKcal?: boolean;
    locale?: 'hu' | 'en';
  }) =>
    request<MealPlanWeek & { filled: number }>('/meal-plan/generate', {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),
  missing: (opts?: { weekStart?: string; ownerId?: string }) => {
    const p = new URLSearchParams();
    if (opts?.weekStart) p.set('weekStart', opts.weekStart);
    if (opts?.ownerId) p.set('ownerId', opts.ownerId);
    const q = p.toString();
    return request<{
      recipeId: string;
      recipeTitle: string;
      lines: Array<{ name: string; qtyLabel?: string; foodId?: string }>;
    }>(`/meal-plan/missing${q ? `?${q}` : ''}`);
  },
  addToCart: (data?: { weekStart?: string; ownerId?: string; listId?: string }) =>
    request<{
      added: number;
      listId: string | null;
      recipeId: string;
      recipeTitle: string;
      lines: Array<{ name: string; qtyLabel?: string; foodId?: string }>;
    }>('/meal-plan/cart', { method: 'POST', body: JSON.stringify(data ?? {}) }),
};

export const pantryApi = {
  list: (ownerId?: string) => {
    const q = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : '';
    return request<{ items: PantryItem[] }>(`/pantry${q}`);
  },
  add: (data: {
    ownerId?: string;
    foodId?: string | null;
    name: string;
    quantity: number;
    unit?: string;
    expiresOn?: string | null;
    source?: string;
  }) => request<{ item: PantryItem }>('/pantry', { method: 'POST', body: JSON.stringify(data) }),
  patch: (id: string, data: { name?: string; quantity?: number; unit?: string; expiresOn?: string | null }) =>
    request<{ deleted: boolean; item: PantryItem | null }>(`/pantry/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  remove: (id: string) => request<{ ok: boolean }>(`/pantry/${id}`, { method: 'DELETE' }),
};

export type ShareCategory = 'FOOD' | 'WEIGHT' | 'WATER' | 'BODY' | 'CART' | 'MEAL_PLAN';
export type ShareStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';

export type ShareDto = {
  id: string;
  direction: 'outgoing' | 'incoming';
  categories: ShareCategory[];
  status: ShareStatus;
  createdAt: string;
  acceptedAt: string | null;
  owner: { id: string; username: string; email: string };
  partner: { id: string; username: string; email: string };
};

export type ShareLiveItem = {
  id: string;
  title: string;
  meta: string;
  at: string;
};

export type CartItemDto = {
  id: string;
  name: string;
  qtyLabel?: string;
  foodId?: string;
  recipeId?: string;
  checked: boolean;
  addedAt: number;
};

export type CartListDto = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
  shared: boolean;
  ownerLabel?: string;
  sharedWith?: string[];
  items: CartItemDto[];
};

export type NotificationPrefs = {
  mealEnabled: boolean;
  mealBreakfast: boolean;
  mealLunch: boolean;
  mealDinner: boolean;
  mealSnack: boolean;
  mealBreakfastAt: string;
  mealLunchAt: string;
  mealDinnerAt: string;
  mealSnackAt: string;
  waterEnabled: boolean;
  waterEveryHours: 1 | 2 | 3 | 4;
  waterQuietStart: string;
  waterQuietEnd: string;
  dailySummaryEnabled: boolean;
  dailySummaryAt: string;
  cartPartnerEnabled: boolean;
  shareInviteEnabled: boolean;
  fastingGoalEnabled: boolean;
  timezone: string;
  vapidPublicKey: string | null;
};

export const notificationsApi = {
  vapidPublic: () => request<{ publicKey: string }>('/notifications/vapid-public'),
  getPrefs: () => request<NotificationPrefs>('/notifications/prefs'),
  updatePrefs: (data: Partial<Omit<NotificationPrefs, 'vapidPublicKey' | 'timezone'>> & { timezone?: string }) =>
    request<NotificationPrefs>('/notifications/prefs', { method: 'PUT', body: JSON.stringify(data) }),
  subscribe: (data: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }) =>
    request<{ ok: boolean }>('/notifications/subscribe', { method: 'POST', body: JSON.stringify(data) }),
  unsubscribe: (endpoint: string) =>
    request<{ ok: boolean }>('/notifications/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),
};

export const sharesApi = {
  list: () => request<{ pendingIncomingCount: number; shares: ShareDto[] }>('/shares'),
  create: (data: { email: string; categories: ShareCategory[] }) =>
    request<ShareDto>('/shares', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, categories: ShareCategory[]) =>
    request<ShareDto>(`/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ categories }) }),
  accept: (id: string) => request<ShareDto>(`/shares/${id}/accept`, { method: 'POST' }),
  decline: (id: string) => request<ShareDto>(`/shares/${id}/decline`, { method: 'POST' }),
  revoke: (id: string) => request<ShareDto>(`/shares/${id}/revoke`, { method: 'POST' }),
  live: (id: string, category: Exclude<ShareCategory, 'CART'>) =>
    request<{ category: ShareCategory; items: ShareLiveItem[] }>(`/shares/${id}/live/${category}`),
};

export const cartApi = {
  list: () => request<{ lists: CartListDto[] }>('/cart/lists'),
  migrate: (lists: Array<{ name: string; items: Array<Omit<CartItemDto, 'id'> & { id?: string }> }>) =>
    request<{ lists: CartListDto[] }>('/cart/migrate', { method: 'POST', body: JSON.stringify({ lists }) }),
  createList: (name: string) =>
    request<CartListDto>('/cart/lists', { method: 'POST', body: JSON.stringify({ name }) }),
  renameList: (id: string, name: string) =>
    request<CartListDto>(`/cart/lists/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteList: (id: string) => request<{ ok: boolean }>(`/cart/lists/${id}`, { method: 'DELETE' }),
  addItem: (
    listId: string,
    data: { name: string; qtyLabel?: string; foodId?: string; recipeId?: string },
  ) => request<{ list: CartListDto }>(`/cart/lists/${listId}/items`, { method: 'POST', body: JSON.stringify(data) }),
  addRecipe: (listId: string, recipeId: string, lines: Array<{ name: string; qtyLabel?: string; foodId?: string }>) =>
    request<{ list: CartListDto }>(`/cart/lists/${listId}/recipe`, {
      method: 'POST',
      body: JSON.stringify({ recipeId, lines }),
    }),
  clearChecked: (listId: string) =>
    request<{ list: CartListDto }>(`/cart/lists/${listId}/clear-checked`, { method: 'POST' }),
  updateItem: (id: string, data: { name?: string; qtyLabel?: string | null; checked?: boolean }) =>
    request<{ list: CartListDto }>(`/cart/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteItem: (id: string) => request<{ list: CartListDto }>(`/cart/items/${id}`, { method: 'DELETE' }),
  subscribeEvents: (onEvent: () => void): (() => void) => {
    const ac = new AbortController();
    const run = async () => {
      while (!ac.signal.aborted) {
        try {
          const headers: Record<string, string> = {};
          const token = getAccessToken();
          if (token) headers.Authorization = `Bearer ${token}`;
          const res = await fetch(`${API_BASE}/cart/events`, { headers, signal: ac.signal });
          if (!res.ok || !res.body) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          onEvent();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          while (!ac.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop() ?? '';
            for (const part of parts) {
              if (part.includes('data:')) onEvent();
            }
          }
        } catch {
          if (ac.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    };
    void run();
    return () => ac.abort();
  },
};
