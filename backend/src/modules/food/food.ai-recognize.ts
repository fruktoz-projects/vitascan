/**
 * Gemini: étel / étkezés felismerés fotóból vagy szövegből.
 * A képet NEM tároljuk — csak a requestben megy a Geminihez.
 */
import { geminiModelChain } from '../../utils/geminiModels';

export type RecognizedIngredient = {
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
  /** Default logging unit: g | db | adag | ek */
  servingUnit?: string;
  /** Grams equal to 1 servingUnit */
  servingSize?: number;
};

export type FoodRecognizeResult = {
  dishName: string;
  ingredients: RecognizedIngredient[];
};

export type FoodRecognizeInput = {
  locale: 'hu' | 'en';
  mode: 'photo' | 'text';
  text?: string;
  imageBase64?: string;
  mimeType?: string;
};

const MAX_INGREDIENTS = 20;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    dishName: { type: 'STRING' },
    ingredients: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          amountG: { type: 'NUMBER' },
          kcal: { type: 'NUMBER' },
          protein: { type: 'NUMBER' },
          carbs: { type: 'NUMBER' },
          fat: { type: 'NUMBER' },
          fiber: { type: 'NUMBER' },
          sugar: { type: 'NUMBER' },
          brand: { type: 'STRING' },
          barcode: { type: 'STRING' },
          servingUnit: { type: 'STRING' },
          servingSize: { type: 'NUMBER' },
        },
        required: ['name', 'amountG', 'kcal', 'protein', 'carbs', 'fat', 'servingUnit', 'servingSize'],
      },
    },
  },
  required: ['dishName', 'ingredients'],
};

type GenConfig = Record<string, unknown>;

/** Single Gemini call budget. Kept short so a gateway (nginx/tunnel) never cuts the connection first. */
const ATTEMPT_TIMEOUT_MS = 28_000;
/** Whole recognition budget across models/attempts. */
const TOTAL_BUDGET_MS = 55_000;

function withThinking(model: string, config: GenConfig): GenConfig {
  if (/gemini-3/i.test(model)) {
    return { ...config, thinkingConfig: { thinkingLevel: 'low' } };
  }
  if (/gemini-2\.5-flash/i.test(model) && !/pro/i.test(model)) {
    return { ...config, thinkingConfig: { thinkingBudget: 0 } };
  }
  return config;
}

/**
 * Fallback ladder: schema → schema-less JSON → plain call.
 * A strict responseSchema plus thinking tokens often ends in MAX_TOKENS / empty
 * output on photos, so every later attempt drops one constraint.
 */
function buildAttemptConfigs(model: string): GenConfig[] {
  return [
    withThinking(model, {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    }),
    withThinking(model, {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    }),
    { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' },
  ];
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function cleanOptionalLabel(raw: unknown, maxLen: number): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (
    lower === 'unknown' ||
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'none' ||
    lower === 'null' ||
    lower === 'undefined' ||
    lower === 'ismeretlen' ||
    lower === 'nincs'
  ) {
    return undefined;
  }
  return s.slice(0, maxLen);
}

function systemPrompt(locale: 'hu' | 'en') {
  if (locale === 'en') {
    return `You are VitaScan's nutrition estimator.
Identify foods / meal ingredients from a photo or text description.
Return ONLY JSON matching the schema.
Rules:
- Split into realistic ingredients (not one vague "meal" row) when possible.
- amountG = estimated grams for that ingredient portion shown/described.
- kcal, protein, carbs, fat are TOTAL for that amount (not per 100g).
- fiber and sugar optional totals for that amount.
- brand and barcode are optional per ingredient. Fill them ONLY when clearly visible on packaging / stated in the text. If not clearly identifiable, leave brand and barcode as empty strings — NEVER guess or invent them.
- servingUnit: one of "g", "db" (piece), "adag" (serving), "ek" (tablespoon), "szelet" (slice) — the most natural default unit for logging this food later.
- servingSize: grams equal to ONE unit of servingUnit (precise typical edible weight). If servingUnit is "g", set servingSize to a sensible default portion in grams (often same as amountG or 100).
- Example: banana → servingUnit "db", servingSize ~118; egg → "db" ~55; oil → "ek" ~14; bread → "szelet" ~30–40; yogurt cup → "adag" or "g".
- For macros: if uncertain, still give a best estimate with reasonable portions.
- Max ${MAX_INGREDIENTS} ingredients.
- dishName: short meal title.`;
  }
  return `Te a VitaScan tápanyag-becslője vagy.
Azonosítsd az ételeket / hozzávalókat fotóból vagy szöveges leírásból.
Csak a sémának megfelelő JSON-t adj vissza.
Szabályok:
- Ha lehet, bontsd realisztikus hozzávalókra (ne egy vagus „étel” sor).
- amountG = becsült gramm az adott hozzávaló látható/leírt adagjára.
- kcal, protein, carbs, fat = ÖSSZESEN erre a mennyiségre (nem 100g-ra).
- fiber és sugar opcionális összesen ugyanarra a mennyiségre.
- brand és barcode opcionális. Csak ha egyértelműen látszik / szerepel. Ha nem, üres string — SOHA ne találj ki.
- servingUnit: "g", "db", "adag", "ek" vagy "szelet" — a legtermészetesebb alap egység későbbi naplózáshoz.
- servingSize: EGY servingUnit gramm-egyenértéke (precíz tipikus ehető súly). Ha servingUnit "g", a servingSize legyen ésszerű alap adag grammban (gyakran amountG vagy 100).
- Példa: banán → servingUnit "db", servingSize ~118; tojás → "db" ~55; olaj → "ek" ~14; kenyér → "szelet" ~30–40; joghurt → "adag" vagy "g".
- Makróknál bizonytalanság esetén is adj legjobb becslést.
- Max ${MAX_INGREDIENTS} hozzávaló.
- dishName: rövid ételcím.`;
}

function parseResult(raw: unknown): FoodRecognizeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const dishName = String(o.dishName ?? '').trim();
  if (!dishName || !Array.isArray(o.ingredients)) return null;

  const ingredients: RecognizedIngredient[] = [];
  for (const item of o.ingredients.slice(0, MAX_INGREDIENTS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    const amountG = Number(r.amountG);
    const kcal = Number(r.kcal);
    const protein = Number(r.protein);
    const carbs = Number(r.carbs);
    const fat = Number(r.fat);
    if (!name || name.length < 1) continue;
    if (![amountG, kcal, protein, carbs, fat].every((n) => Number.isFinite(n) && n >= 0)) continue;
    const fiber = r.fiber != null ? Number(r.fiber) : undefined;
    const sugar = r.sugar != null ? Number(r.sugar) : undefined;
    const brand = cleanOptionalLabel(r.brand, 80);
    const barcode = cleanOptionalLabel(r.barcode, 30);
    const unitRaw = String(r.servingUnit ?? 'g').trim().toLowerCase();
    const servingUnit = ['g', 'db', 'adag', 'ek', 'szelet'].includes(unitRaw) ? unitRaw : 'g';
    let servingSize = Number(r.servingSize);
    if (!Number.isFinite(servingSize) || servingSize <= 0) {
      servingSize = servingUnit === 'g' ? amountG : amountG;
    }
    ingredients.push({
      name: name.slice(0, 120),
      amountG: round1(clamp(amountG, 1, 5000)),
      kcal: round1(clamp(kcal, 0, 10000)),
      protein: round1(clamp(protein, 0, 1000)),
      carbs: round1(clamp(carbs, 0, 1000)),
      fat: round1(clamp(fat, 0, 1000)),
      ...(Number.isFinite(fiber) && (fiber as number) >= 0
        ? { fiber: round1(clamp(fiber as number, 0, 1000)) }
        : {}),
      ...(Number.isFinite(sugar) && (sugar as number) >= 0
        ? { sugar: round1(clamp(sugar as number, 0, 1000)) }
        : {}),
      ...(brand ? { brand } : {}),
      ...(barcode ? { barcode } : {}),
      servingUnit,
      servingSize: round1(clamp(servingSize, 0.1, 2000)),
    });
  }

  if (!ingredients.length) return null;
  return { dishName: dishName.slice(0, 120), ingredients };
}

function extractJsonText(body: any): string {
  const parts: Array<{ text?: string; thought?: boolean }> =
    body?.candidates?.[0]?.content?.parts || [];
  let text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return text;
}

/** Closing brackets needed to terminate `src`, or null if it ends inside a string. */
function pendingClosers(src: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) return null;
  return stack.reverse().join('');
}

/** MAX_TOKENS cuts the JSON mid-array — keep the ingredients that did arrive. */
function parseMaybeTruncatedJson(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const src = text.slice(start);
  try {
    return JSON.parse(src);
  } catch {
    /* fall through to repair */
  }
  let end = src.lastIndexOf('}');
  for (let tries = 0; end > 0 && tries < 40; tries += 1) {
    const head = src.slice(0, end + 1);
    const closers = pendingClosers(head);
    if (closers != null) {
      try {
        return JSON.parse(head + closers);
      } catch {
        /* keep trimming */
      }
    }
    end = src.lastIndexOf('}', end - 1);
  }
  return null;
}

type FailureKind =
  | 'timeout'
  | 'network'
  | 'rate'
  | 'image'
  | 'config'
  | 'http'
  | 'empty'
  | 'parse';

type Failure = { kind: FailureKind; detail: string };

type AttemptOutcome =
  | { result: FoodRecognizeResult; failure?: undefined }
  | { result?: undefined; failure: Failure };

function buildUserParts(input: FoodRecognizeInput) {
  const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (input.mode === 'photo' && input.imageBase64) {
    const mime = (input.mimeType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    const data = input.imageBase64.replace(/^data:[^;]+;base64,/, '');
    userParts.push({ inlineData: { mimeType: mime, data } });
    userParts.push({
      text:
        input.locale === 'en'
          ? 'Estimate ingredients and macros for this meal photo. Include brand/barcode only if clearly readable. Return JSON only.'
          : 'Becslés: hozzávalók és makrók erről az ételfotóról. Brand/vonalkód csak ha egyértelműen olvasható. Csak JSON.',
    });
  } else {
    userParts.push({
      text:
        (input.locale === 'en'
          ? 'Estimate ingredients and macros for this meal description. Include brand/barcode only if explicitly stated:\n'
          : 'Becslés: hozzávalók és makrók ehhez a leíráshoz. Brand/vonalkód csak ha egyértelműen szerepel:\n') +
        (input.text || ''),
    });
  }

  return userParts;
}

async function callGeminiOnce(
  apiKey: string,
  model: string,
  input: FoodRecognizeInput,
  generationConfig: GenConfig,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(input.locale) }] },
        contents: [{ role: 'user', parts: buildUserParts(input) }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { failure: { kind: 'timeout', detail: `${model}: timeout ${timeoutMs}ms` } };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { failure: { kind: 'network', detail: `${model}: ${detail}` } };
  }

  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as
      | { error?: { message?: string; status?: string } }
      | null;
    const msg = errBody?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429 || /quota|resource exhausted|rate limit/i.test(msg)) {
      return { failure: { kind: 'rate', detail: `${model}: ${msg}` } };
    }
    if (/image|mime|unsupported|media/i.test(msg)) {
      return { failure: { kind: 'image', detail: `${model}: ${msg}` } };
    }
    if (/invalid argument|unknown name|thinking|schema|responseMimeType|not supported/i.test(msg)) {
      return { failure: { kind: 'config', detail: `${model}: ${msg}` } };
    }
    return { failure: { kind: 'http', detail: `${model}: HTTP ${res.status} ${msg}` } };
  }

  const body = (await res.json().catch(() => null)) as any;
  if (!body) return { failure: { kind: 'parse', detail: `${model}: non-JSON Gemini body` } };

  const blockReason = body?.promptFeedback?.blockReason;
  if (blockReason) {
    return { failure: { kind: 'image', detail: `${model}: blocked (${blockReason})` } };
  }

  const finishReason = body?.candidates?.[0]?.finishReason || '';
  const text = extractJsonText(body);
  if (!text) {
    return { failure: { kind: 'empty', detail: `${model}: empty output (${finishReason || 'no reason'})` } };
  }

  const parsed = parseMaybeTruncatedJson(text);
  const result = parsed ? parseResult(parsed) : null;
  if (!result) {
    return {
      failure: {
        kind: 'parse',
        detail: `${model}: unusable JSON (${finishReason || 'no reason'}, ${text.length} chars)`,
      },
    };
  }

  return { result };
}

export type RecognizeLogger = (message: string, meta?: Record<string, unknown>) => void;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function failureToError(failure: Failure | null, locale: 'hu' | 'en'): Error {
  const en = locale === 'en';
  switch (failure?.kind) {
    case 'timeout':
      return httpError(
        504,
        en
          ? 'Recognition timed out. Try again with a smaller, sharper photo.'
          : 'A felismerés időtúllépés miatt megszakadt. Próbáld újra kisebb, élesebb fotóval.',
      );
    case 'rate':
      return httpError(
        429,
        en
          ? 'The recognition service is busy right now. Try again in a moment.'
          : 'A felismerő szolgáltatás most túlterhelt. Próbáld újra kicsit később.',
      );
    case 'image':
      return httpError(
        400,
        en
          ? 'This photo could not be processed. Try another shot or a JPEG from the gallery.'
          : 'Ez a fotó nem dolgozható fel. Próbálj másik képet, vagy JPEG-et a galériából.',
      );
    case 'network':
    case 'http':
      return httpError(
        502,
        en
          ? 'Could not reach the recognition service. Try again in a moment.'
          : 'A felismerő szolgáltatás most nem érhető el. Próbáld újra kicsit később.',
      );
    default:
      return httpError(
        502,
        en
          ? 'Could not recognize the food. Try another photo or a clearer description.'
          : 'Nem sikerült felismerni az ételt. Próbálj másik képet vagy pontosabb leírást.',
      );
  }
}

export async function recognizeFoodWithGemini(
  input: FoodRecognizeInput,
  log?: RecognizeLogger,
): Promise<FoodRecognizeResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw httpError(503, 'Gemini API kulcs nincs beállítva.');
  }

  if (input.mode === 'text' && !String(input.text || '').trim()) {
    throw httpError(400, 'Adj meg egy szöveges leírást.');
  }
  if (input.mode === 'photo' && !input.imageBase64) {
    throw httpError(400, 'Hiányzik a kép.');
  }

  const models = geminiModelChain();

  const startedAt = Date.now();
  let lastFailure: Failure | null = null;

  for (const model of models) {
    for (const generationConfig of buildAttemptConfigs(model)) {
      const left = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      // Stop before a gateway would kill the connection and return a non-JSON 502.
      if (left < 6_000) {
        log?.('ai-recognize: out of time budget', { model, lastFailure: lastFailure?.detail });
        throw failureToError(lastFailure ?? { kind: 'timeout', detail: 'budget exhausted' }, input.locale);
      }

      const outcome = await callGeminiOnce(
        apiKey,
        model,
        input,
        generationConfig,
        Math.min(ATTEMPT_TIMEOUT_MS, left),
      );
      if (outcome.result) return outcome.result;

      lastFailure = outcome.failure;
      log?.('ai-recognize: Gemini attempt failed', {
        model,
        kind: outcome.failure.kind,
        detail: outcome.failure.detail,
        elapsedMs: Date.now() - startedAt,
      });

      // Same image will be rejected by every model.
      if (outcome.failure.kind === 'image') {
        throw failureToError(outcome.failure, input.locale);
      }
      // Per-model quota/overload, dead endpoint, or network: skip remaining
      // configs and try the next model in geminiModelChain().
      if (
        outcome.failure.kind === 'rate' ||
        outcome.failure.kind === 'network' ||
        outcome.failure.kind === 'http'
      ) {
        break;
      }
    }
  }

  throw failureToError(lastFailure, input.locale);
}
