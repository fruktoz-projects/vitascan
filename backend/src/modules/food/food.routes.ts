import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { scanLimitGuard } from '../../middleware/tierGuard';
import { fetchOFFByBarcode, searchOFF, type OFFNormalizedFood } from '../../services/openFoodFacts';
import { searchUSDA, type USDANormalizedFood } from '../../services/usdaFoodData';
import { checkProfanity } from '../../utils/profanity';
import {
  compareFoodsForSearch,
  findFoodIdsByAccentInsensitiveName,
  foodHasCyrillic,
  mapFoodResponse,
  resolveOrigin,
  type FoodOrigin,
} from '../../utils/foodSearch';
import { recognizeFoodWithGemini } from './food.ai-recognize';
import { fillFoodLabelWithGemini } from './food.ai-label-fill';
import {
  estimateServingWithGemini,
  SERVING_UNITS,
} from './food.ai-serving-estimate';

export const AI_FOOD_RECOGNIZE_DAILY_LIMIT = 20;

// ─── Validation schemas ───────────────────────────────────────────────────────

const ServingUnitSchema = z.enum(SERVING_UNITS);

const CreateFoodSchema = z.object({
  name: z.string().min(2).max(120),
  nameHu: z.string().min(2).max(120).optional(),
  nameEn: z.string().min(2).max(120).optional(),
  brand: z.string().max(80).nullable().optional(),
  barcode: z.string().max(30).nullable().optional(),
  kcal: z.number().min(0).max(10000),
  protein: z.number().min(0).max(1000),
  carbs: z.number().min(0).max(1000),
  fat: z.number().min(0).max(1000),
  fiber: z.number().min(0).max(1000).nullable().optional(),
  sugar: z.number().min(0).max(1000).nullable().optional(),
  /** Grams equal to 1 servingUnit (e.g. 1 db banana ≈ 118). */
  servingSize: z.number().min(0).optional(),
  servingUnit: ServingUnitSchema.optional(),
  source: z.enum(['INTERNAL', 'USER_SCAN', 'EXTERNAL_API']).default('USER_SCAN'),
  isPrepared: z.boolean().optional(),
  components: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        amountG: z.number().min(0.1),
        kcal: z.number().min(0),
        protein: z.number().min(0),
        carbs: z.number().min(0),
        fat: z.number().min(0),
        fiber: z.number().min(0).nullable().optional(),
        sugar: z.number().min(0).nullable().optional(),
        sortOrder: z.number().int().min(0).optional(),
      }),
    )
    .max(30)
    .optional(),
});

const VoteSchema = z.object({
  value: z.literal(1).or(z.literal(-1)),
});

type ExternalCandidate = OFFNormalizedFood | USDANormalizedFood;

type CachedExternal = {
  expiresAt: number;
  items: ExternalCandidate[];
};

const externalSearchCache = new Map<string, CachedExternal>();
const EXTERNAL_CACHE_TTL_MS = 60_000;
const MIN_EXTERNAL_QUERY_LEN = 3;

function getCachedExternal(q: string): ExternalCandidate[] | null {
  const key = q.toLowerCase().trim();
  const hit = externalSearchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    externalSearchCache.delete(key);
    return null;
  }
  return hit.items;
}

function setCachedExternal(q: string, items: ExternalCandidate[]) {
  const key = q.toLowerCase().trim();
  externalSearchCache.set(key, { expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS, items });
  if (externalSearchCache.size > 200) {
    const first = externalSearchCache.keys().next().value;
    if (first) externalSearchCache.delete(first);
  }
}

const foodInclude = {
  creator: { select: { username: true, reputation: true } },
  _count: { select: { votes: true } },
} as const;

async function favoriteIdSet(prisma: any, userId: string, foodIds: string[]): Promise<Set<string>> {
  if (foodIds.length === 0) return new Set();
  const rows = await prisma.foodFavorite.findMany({
    where: { userId, foodId: { in: foodIds } },
    select: { foodId: true },
  });
  return new Set(rows.map((r: { foodId: string }) => r.foodId));
}

async function upsertExternalFood(
  prisma: any,
  candidate: ExternalCandidate,
  creatorId: string,
) {
  if (foodHasCyrillic(candidate)) return null;

  const externalId = candidate.externalId;
  const barcode = candidate.barcode;

  if (externalId) {
    const byExt = await prisma.food.findUnique({
      where: { externalId },
      include: foodInclude,
    });
    if (byExt && byExt.status !== 'BANNED') return byExt;
  }

  if (barcode) {
    const byBarcode = await prisma.food.findUnique({
      where: { barcode },
      include: foodInclude,
    });
    if (byBarcode && byBarcode.status !== 'BANNED') {
      if (externalId && !byBarcode.externalId) {
        try {
          return await prisma.food.update({
            where: { id: byBarcode.id },
            data: { externalId },
            include: foodInclude,
          });
        } catch {
          return byBarcode;
        }
      }
      return byBarcode;
    }
  }

  try {
    const saved = await prisma.food.create({
      data: {
        name: candidate.name,
        nameHu: candidate.name,
        nameEn: candidate.name,
        brand: candidate.brand,
        barcode: barcode || undefined,
        externalId: externalId || undefined,
        kcal: candidate.kcal,
        protein: candidate.protein,
        carbs: candidate.carbs,
        fat: candidate.fat,
        fiber: candidate.fiber,
        sugar: candidate.sugar,
        servingSize: candidate.servingSize ?? 100,
        servingUnit: candidate.servingUnit ?? 'g',
        status: 'UNVERIFIED',
        tier: 'FREE',
        source: 'EXTERNAL_API',
        creatorId,
      },
      include: foodInclude,
    });
    await seedCreatorUpvote(prisma, saved.id, creatorId);
    return saved;
  } catch {
    if (externalId) {
      const again = await prisma.food.findUnique({
        where: { externalId },
        include: foodInclude,
      });
      if (again && again.status !== 'BANNED') return again;
    }
    if (barcode) {
      const again = await prisma.food.findUnique({
        where: { barcode },
        include: foodInclude,
      });
      if (again && again.status !== 'BANNED') return again;
    }
    return null;
  }
}

function decorateFoods(
  foods: any[],
  favIds: Set<string>,
  originOverride?: (f: any) => FoodOrigin,
) {
  return foods
    .filter((f) => !foodHasCyrillic(f))
    .map((food) =>
      mapFoodResponse(food, {
        origin: originOverride?.(food) ?? resolveOrigin(food, false),
        isFavorite: favIds.has(food.id),
      }),
    );
}

const SEARCH_SCOPES = new Set(['favorites', 'frequent', 'recent', 'mine']);

async function scopedFoodIds(
  prisma: any,
  userId: string,
  scope: string,
): Promise<string[] | null> {
  if (scope === 'favorites') {
    const rows = await prisma.foodFavorite.findMany({
      where: { userId },
      select: { foodId: true },
    });
    return rows.map((r: { foodId: string }) => r.foodId);
  }
  if (scope === 'frequent') {
    const grouped = await prisma.dailyLog.groupBy({
      by: ['foodId'],
      where: { userId, foodId: { not: null } },
      _count: { foodId: true },
      orderBy: { _count: { foodId: 'desc' } },
      take: 100,
    });
    return grouped
      .map((g: { foodId: string | null }) => g.foodId)
      .filter(Boolean) as string[];
  }
  if (scope === 'recent') {
    const logs = await prisma.dailyLog.findMany({
      where: { userId, foodId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { foodId: true },
    });
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const row of logs) {
      if (!row.foodId || seen.has(row.foodId)) continue;
      seen.add(row.foodId);
      ids.push(row.foodId);
    }
    return ids;
  }
  return null;
}

async function userFoodUsageCounts(prisma: any, userId: string): Promise<Map<string, number>> {
  const grouped = await prisma.dailyLog.groupBy({
    by: ['foodId'],
    where: { userId, foodId: { not: null } },
    _count: { foodId: true },
  });
  const map = new Map<string, number>();
  for (const g of grouped) {
    if (g.foodId) map.set(g.foodId, g._count.foodId);
  }
  return map;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function foodRoutes(fastify: FastifyInstance) {

  // GET /foods — saját DB + OFF + USDA
  fastify.get('/', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { q = '', status, limit = '20', offset = '0', mine, scope: scopeRaw } =
      req.query as any;

    const prisma = (fastify as any).prisma;
    const user = (req as any).user;
    const userId = user.userId ?? user.id;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const query = String(q).trim();
    const scope = SEARCH_SCOPES.has(String(scopeRaw || '').toLowerCase())
      ? String(scopeRaw).toLowerCase()
      : '';
    const onlyMine = mine === '1' || mine === 'true' || scope === 'mine';

    const where: any = {
      status: status ?? { not: 'BANNED' },
      preparedFromRecipeId: null,
    };
    if (onlyMine) {
      where.creatorId = userId;
      // Csak kézi / AI által mentett ételek — keresésből betöltött EXTERNAL_API ne jelenjen meg
      where.source = 'USER_SCAN';
      where.externalId = null;
    }
    const scopedIds = scope && scope !== 'mine' ? await scopedFoodIds(prisma, userId, scope) : null;
    if (scopedIds && scopedIds.length === 0) {
      return reply.send({ foods: [], total: 0 });
    }

    let foodsRaw: any[] = [];
    let totalLocal = 0;
    const matchedIds = query ? await findFoodIdsByAccentInsensitiveName(prisma, query) : null;
    if (matchedIds && matchedIds.length === 0) {
      return reply.send({ foods: [], total: 0 });
    }

    let allowedIds: string[] | null = null;
    if (scopedIds && matchedIds) {
      const matchedSet = new Set(matchedIds);
      allowedIds = scopedIds.filter((id) => matchedSet.has(id));
    } else if (scopedIds) {
      allowedIds = scopedIds;
    } else if (matchedIds) {
      allowedIds = matchedIds;
    }
    if (allowedIds) {
      if (allowedIds.length === 0) return reply.send({ foods: [], total: 0 });
      where.id = { in: allowedIds };
    }

    [foodsRaw, totalLocal] = await Promise.all([
      prisma.food.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: foodInclude,
      }),
      prisma.food.count({ where }),
    ]);

    const usageCounts = query ? await userFoodUsageCounts(prisma, userId) : undefined;

    const localSorted = foodsRaw
      .filter((f: any) => !foodHasCyrillic(f))
      .slice()
      .sort((a: any, b: any) => compareFoodsForSearch(a, b, query, usageCounts));

    const localPage = localSorted.slice(off, off + lim);

    const shouldFetchExternal =
      !onlyMine && !scope && query.length >= MIN_EXTERNAL_QUERY_LEN && off === 0;

    let externalFoods: any[] = [];

    if (shouldFetchExternal) {
      let candidates = getCachedExternal(query);

      if (!candidates) {
        const [offHits, usdaHits] = await Promise.all([
          searchOFF(query).catch(() => [] as OFFNormalizedFood[]),
          searchUSDA(query).catch(() => [] as USDANormalizedFood[]),
        ]);
        candidates = [...offHits, ...usdaHits].filter((c) => !foodHasCyrillic(c));
        setCachedExternal(query, candidates);
      } else {
        candidates = candidates.filter((c) => !foodHasCyrillic(c));
      }

      const seenIds = new Set(localPage.map((f: any) => f.id as string));
      const seenBarcodes = new Set(
        localPage.map((f: any) => f.barcode).filter(Boolean) as string[],
      );
      const seenExternalIds = new Set(
        localPage.map((f: any) => f.externalId).filter(Boolean) as string[],
      );

      const slotsLeft = Math.max(0, lim - localPage.length);

      for (const candidate of candidates) {
        if (!candidate.externalId && !candidate.barcode) continue;
        if (candidate.externalId && seenExternalIds.has(candidate.externalId)) continue;
        if (candidate.barcode && seenBarcodes.has(candidate.barcode)) continue;

        const saved = await upsertExternalFood(prisma, candidate, userId);
        if (!saved || foodHasCyrillic(saved)) continue;

        if (saved.barcode) seenBarcodes.add(saved.barcode);
        if (saved.externalId) seenExternalIds.add(saved.externalId);

        if (localSorted.some((f: any) => f.id === saved.id) || seenIds.has(saved.id)) {
          seenIds.add(saved.id);
          continue;
        }

        seenIds.add(saved.id);

        if (externalFoods.length < slotsLeft) {
          externalFoods.push(saved);
        }
      }

      externalFoods.sort((a, b) => compareFoodsForSearch(a, b, query, usageCounts));
    }

    const combined = [...localPage, ...externalFoods]
      .slice()
      .sort((a, b) => compareFoodsForSearch(a, b, query, usageCounts))
      .slice(0, lim);
    const favIds = await favoriteIdSet(prisma, userId, combined.map((f) => f.id));

    const foods = combined.map((food) => {
      const fromExternal = externalFoods.some((e) => e.id === food.id);
      return mapFoodResponse(food, {
        origin: resolveOrigin(food, fromExternal),
        isFavorite: favIds.has(food.id),
      });
    });

    return reply.send({
      foods,
      total: totalLocal + (shouldFetchExternal ? externalFoods.length : 0),
    });
  });

  // GET /foods/recent — legutóbb naplózott egyedi ételek
  fastify.get('/recent', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const limit = Math.min(parseInt(String((req.query as any).limit ?? '20'), 10) || 20, 50);

    const logs = await prisma.dailyLog.findMany({
      where: { userId, foodId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { foodId: true },
    });

    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const row of logs) {
      if (!row.foodId || seen.has(row.foodId)) continue;
      seen.add(row.foodId);
      orderedIds.push(row.foodId);
      if (orderedIds.length >= limit) break;
    }

    if (orderedIds.length === 0) return reply.send({ foods: [], total: 0 });

    const foodsRaw = await prisma.food.findMany({
      where: { id: { in: orderedIds }, status: { not: 'BANNED' } },
      include: foodInclude,
    });
    const byId = new Map(foodsRaw.map((f: any) => [f.id, f]));
    const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    const favIds = await favoriteIdSet(prisma, userId, ordered.map((f: any) => f.id));

    return reply.send({
      foods: decorateFoods(ordered, favIds),
      total: ordered.length,
    });
  });

  // GET /foods/frequent — leggyakrabban naplózott
  fastify.get('/frequent', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const limit = Math.min(parseInt(String((req.query as any).limit ?? '20'), 10) || 20, 50);

    const grouped = await prisma.dailyLog.groupBy({
      by: ['foodId'],
      where: { userId, foodId: { not: null } },
      _count: { foodId: true },
      orderBy: { _count: { foodId: 'desc' } },
      take: limit,
    });

    const ids = grouped.map((g: { foodId: string | null }) => g.foodId).filter(Boolean) as string[];
    if (ids.length === 0) return reply.send({ foods: [], total: 0 });

    const foodsRaw = await prisma.food.findMany({
      where: { id: { in: ids }, status: { not: 'BANNED' } },
      include: foodInclude,
    });
    const byId = new Map(foodsRaw.map((f: any) => [f.id, f]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    const favIds = await favoriteIdSet(prisma, userId, ordered.map((f: any) => f.id));

    return reply.send({
      foods: decorateFoods(ordered, favIds),
      total: ordered.length,
    });
  });

  // GET /foods/favorites
  fastify.get('/favorites', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const limit = Math.min(parseInt(String((req.query as any).limit ?? '50'), 10) || 50, 100);

    const favs = await prisma.foodFavorite.findMany({
      where: { userId, food: { status: { not: 'BANNED' } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { food: { include: foodInclude } },
    });

    const foods = favs
      .map((f: any) => f.food)
      .filter((f: any) => f && !foodHasCyrillic(f));

    return reply.send({
      foods: decorateFoods(foods, new Set(foods.map((f: any) => f.id))),
      total: foods.length,
    });
  });

  // GET /barcode/:barcode
  fastify.get('/barcode/:barcode', {
    preHandler: [authenticate, scanLimitGuard],
  }, async (req, reply) => {
    const { barcode } = req.params as { barcode: string };
    const prisma = (fastify as any).prisma;

    const dbFood = await prisma.food.findUnique({
      where: { barcode },
      include: foodInclude,
    });

    if (dbFood && dbFood.status !== 'BANNED') {
      const score = await getScore(prisma, dbFood.id);
      const user = (req as any).user;
      const userId = user.userId ?? user.id;
      const myVoteRow = await prisma.vote.findUnique({
        where: { userId_foodId: { userId, foodId: dbFood.id } },
        select: { value: true },
      });
      return reply.send({
        ...dbFood,
        score,
        myVote: myVoteRow?.value ?? null,
        source: 'DB',
      });
    }

    const offFood = await fetchOFFByBarcode(barcode);

    if (!offFood || foodHasCyrillic(offFood)) {
      return reply.status(404).send({ error: 'Étel nem található az adatbázisban vagy az Open Food Facts-ban.' });
    }

    try {
      const user = (req as any).user;
      const creatorId = user.userId ?? user.id;
      const saved = await prisma.food.create({
        data: {
          name: offFood.name,
          nameHu: offFood.name,
          nameEn: offFood.name,
          brand: offFood.brand,
          barcode: offFood.barcode,
          externalId: offFood.externalId,
          kcal: offFood.kcal,
          protein: offFood.protein,
          carbs: offFood.carbs,
          fat: offFood.fat,
          fiber: offFood.fiber,
          sugar: offFood.sugar,
          servingSize: offFood.servingSize ?? 100,
          servingUnit: offFood.servingUnit ?? 'g',
          status: 'UNVERIFIED',
          tier: 'FREE',
          source: 'EXTERNAL_API',
          creatorId,
        },
        include: foodInclude,
      });
      await seedCreatorUpvote(prisma, saved.id, creatorId);
      const score = await getScore(prisma, saved.id);
      return reply.send({ ...saved, score, myVote: 1 as const, source: 'EXTERNAL_API' });
    } catch {
      return reply.send({
        ...offFood,
        id: `off_${barcode}`,
        servingSize: offFood.servingSize ?? 100,
        servingUnit: offFood.servingUnit ?? 'g',
        source: 'EXTERNAL_API',
        status: 'UNVERIFIED',
        tier: 'FREE',
      });
    }
  });

  // POST /foods/ai-recognize — Gemini vision/text (kép NEM tárolódik), napi 20 limit
  fastify.post('/ai-recognize', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const bodySchema = z.object({
      mode: z.enum(['photo', 'text']),
      text: z.string().max(4000).optional(),
      imageBase64: z.string().max(12_000_000).optional(),
      mimeType: z.string().max(64).optional(),
      locale: z.enum(['hu', 'en']).optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { mode, text, imageBase64, mimeType, locale } = parsed.data;
    if (mode === 'text' && !String(text || '').trim()) {
      return reply.status(400).send({ error: 'Adj meg egy szöveges leírást.' });
    }
    if (mode === 'photo' && !imageBase64) {
      return reply.status(400).send({ error: 'Hiányzik a kép.' });
    }

    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usage = await prisma.aiFoodRecognition.upsert({
      where: { userId_loggedDate: { userId, loggedDate: today } },
      create: { userId, loggedDate: today, count: 0 },
      update: {},
    });

    if (usage.count >= AI_FOOD_RECOGNIZE_DAILY_LIMIT) {
      return reply.status(429).send({
        error: `Elérted a napi AI felismerési limitet (${AI_FOOD_RECOGNIZE_DAILY_LIMIT}). Próbáld holnap.`,
        remaining: 0,
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    }

    const updated = await prisma.aiFoodRecognition.update({
      where: { userId_loggedDate: { userId, loggedDate: today } },
      data: { count: { increment: 1 } },
    });

    try {
      const result = await recognizeFoodWithGemini(
        {
          locale: locale ?? 'hu',
          mode,
          text,
          imageBase64,
          mimeType,
        },
        (message, meta) => req.log.warn(meta ?? {}, message),
      );

      return reply.send({
        ...result,
        remaining: Math.max(0, AI_FOOD_RECOGNIZE_DAILY_LIMIT - updated.count),
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    } catch (err: any) {
      const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 502;
      return reply.status(status).send({
        error: err?.message || 'A felismerés sikertelen.',
        remaining: Math.max(0, AI_FOOD_RECOGNIZE_DAILY_LIMIT - updated.count),
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    }
  });

  // POST /foods/ai-serving-estimate — 1 egység tipikus gramm súlya (közös napi AI kvóta)
  fastify.post('/ai-serving-estimate', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const bodySchema = z.object({
      name: z.string().min(1).max(120),
      brand: z.string().max(80).optional(),
      unit: ServingUnitSchema,
      locale: z.enum(['hu', 'en']).optional(),
      kcal: z.number().min(0).max(10000),
      protein: z.number().min(0).max(1000),
      carbs: z.number().min(0).max(1000),
      fat: z.number().min(0).max(1000),
      fiber: z.number().min(0).max(1000).optional(),
      sugar: z.number().min(0).max(1000).optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { name, brand, unit, locale, kcal, protein, carbs, fat, fiber, sugar } = parsed.data;
    if (unit === 'g') {
      return reply.status(400).send({ error: 'Gramm egységhez nincs szükség becslésre.' });
    }

    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usage = await prisma.aiFoodRecognition.upsert({
      where: { userId_loggedDate: { userId, loggedDate: today } },
      create: { userId, loggedDate: today, count: 0 },
      update: {},
    });

    if (usage.count >= AI_FOOD_RECOGNIZE_DAILY_LIMIT) {
      return reply.status(429).send({
        error: `Elérted a napi AI felismerési limitet (${AI_FOOD_RECOGNIZE_DAILY_LIMIT}). Próbáld holnap.`,
        remaining: 0,
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    }

    try {
      const result = await estimateServingWithGemini({
        locale: locale ?? 'hu',
        name,
        brand,
        unit,
        kcal,
        protein,
        carbs,
        fat,
        fiber,
        sugar,
      });

      const updated = await prisma.aiFoodRecognition.update({
        where: { userId_loggedDate: { userId, loggedDate: today } },
        data: { count: { increment: 1 } },
      });

      return reply.send({
        ...result,
        remaining: Math.max(0, AI_FOOD_RECOGNIZE_DAILY_LIMIT - updated.count),
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    } catch (err: any) {
      const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 502;
      return reply.status(status).send({
        error: err?.message || 'A becslés sikertelen.',
        remaining: Math.max(0, AI_FOOD_RECOGNIZE_DAILY_LIMIT - usage.count),
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    }
  });

  // POST /foods/ai-label-fill — termékcímke → űrlap (kép NEM tárolódik), közös napi AI kvóta
  fastify.post('/ai-label-fill', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const bodySchema = z.object({
      imageBase64: z.string().max(12_000_000),
      mimeType: z.string().max(64).optional(),
      locale: z.enum(['hu', 'en']).optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { imageBase64, mimeType, locale } = parsed.data;
    if (!imageBase64) {
      return reply.status(400).send({ error: 'Hiányzik a kép.' });
    }

    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usage = await prisma.aiFoodRecognition.upsert({
      where: { userId_loggedDate: { userId, loggedDate: today } },
      create: { userId, loggedDate: today, count: 0 },
      update: {},
    });

    if (usage.count >= AI_FOOD_RECOGNIZE_DAILY_LIMIT) {
      return reply.status(429).send({
        error: `Elérted a napi AI felismerési limitet (${AI_FOOD_RECOGNIZE_DAILY_LIMIT}). Próbáld holnap.`,
        remaining: 0,
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    }

    try {
      const result = await fillFoodLabelWithGemini({
        locale: locale ?? 'hu',
        imageBase64,
        mimeType,
      });

      const updated = await prisma.aiFoodRecognition.update({
        where: { userId_loggedDate: { userId, loggedDate: today } },
        data: { count: { increment: 1 } },
      });

      return reply.send({
        ...result,
        remaining: Math.max(0, AI_FOOD_RECOGNIZE_DAILY_LIMIT - updated.count),
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    } catch (err: any) {
      const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 502;
      return reply.status(status).send({
        error: err?.message || 'A címke leolvasása sikertelen.',
        remaining: Math.max(0, AI_FOOD_RECOGNIZE_DAILY_LIMIT - usage.count),
        limit: AI_FOOD_RECOGNIZE_DAILY_LIMIT,
      });
    }
  });

  // POST /foods
  fastify.post('/', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const user = (req as any).user;
    const body = CreateFoodSchema.parse(req.body);

    if (checkProfanity(body.name) || (body.brand && checkProfanity(body.brand))) {
      return reply.status(400).send({ error: 'A megadott név nem megfelelő.' });
    }

    const prisma = (fastify as any).prisma;
    const creatorId = user.userId ?? user.id;
    const barcode = typeof body.barcode === 'string' ? body.barcode.trim() || null : body.barcode ?? null;

    if (barcode) {
      const existing = await prisma.food.findUnique({ where: { barcode } });
      if (existing) {
        if (existing.creatorId === creatorId) {
          return reply.status(409).send({
            error: 'Ez az étel már a saját ételeid között szerepel.',
          });
        }
        return reply.status(409).send({
          error: `Már létezik étel ezzel a vonalkóddal (${barcode}).`,
        });
      }
    }

    const food = await prisma.food.create({
      data: {
        name: body.name,
        nameHu: body.nameHu ?? body.name,
        nameEn: body.nameEn ?? body.name,
        brand: body.brand,
        barcode,
        kcal: body.kcal,
        protein: body.protein,
        carbs: body.carbs,
        fat: body.fat,
        fiber: body.fiber,
        sugar: body.sugar,
        servingSize: body.servingSize ?? 100,
        servingUnit: body.servingUnit ?? 'g',
        isPrepared: body.isPrepared === true && (body.components?.length ?? 0) > 0,
        status: 'UNVERIFIED',
        tier: 'FREE',
        source: body.source ?? 'USER_SCAN',
        creatorId,
        ...(body.isPrepared && body.components?.length
          ? {
              components: {
                create: body.components.map((c, i) => ({
                  name: c.name,
                  amountG: c.amountG,
                  kcal: c.kcal,
                  protein: c.protein,
                  carbs: c.carbs,
                  fat: c.fat,
                  fiber: c.fiber ?? undefined,
                  sugar: c.sugar ?? undefined,
                  sortOrder: c.sortOrder ?? i,
                })),
              },
            }
          : {}),
      },
      include: { components: { orderBy: { sortOrder: 'asc' } } },
    });

    await seedCreatorUpvote(prisma, food.id, creatorId);
    const score = await getScore(prisma, food.id);

    return reply.status(201).send({ ...food, score, myVote: 1 });
  });

  // POST /foods/:id/favorite
  fastify.post('/:id/favorite', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const { id } = req.params as { id: string };

    const food = await prisma.food.findUnique({ where: { id } });
    if (!food || food.status === 'BANNED') {
      return reply.status(404).send({ error: 'Étel nem található.' });
    }

    await prisma.foodFavorite.upsert({
      where: { userId_foodId: { userId, foodId: id } },
      create: { userId, foodId: id },
      update: {},
    });

    return reply.send({ isFavorite: true });
  });

  // DELETE /foods/:id/favorite
  fastify.delete('/:id/favorite', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const prisma = (fastify as any).prisma;
    const userId = (req as any).user.userId ?? (req as any).user.id;
    const { id } = req.params as { id: string };

    await prisma.foodFavorite.deleteMany({ where: { userId, foodId: id } });
    return reply.send({ isFavorite: false });
  });

  // GET /foods/:id/edits — közösségi szerkesztési előzmények
  fastify.get('/:id/edits', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const prisma = (fastify as any).prisma;

    const food = await prisma.food.findUnique({ where: { id }, select: { id: true } });
    if (!food) return reply.status(404).send({ error: 'Nem található.' });

    const rows = await prisma.foodEditLog.findMany({
      where: { foodId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { username: true } } },
    });

    return reply.send({
      edits: rows.map((r: { id: string; createdAt: Date; user: { username: string } }) => ({
        id: r.id,
        username: r.user.username,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

  // PATCH /foods/:id — bármely bejelentkezett user szerkeszthet
  fastify.patch('/:id', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const body = CreateFoodSchema.partial().parse(req.body);
    const prisma = (fastify as any).prisma;

    const food = await prisma.food.findUnique({ where: { id } });
    if (!food) return reply.status(404).send({ error: 'Nem található.' });
    const editorId = user.userId ?? user.id;

    if (body.barcode !== undefined) {
      const barcode =
        typeof body.barcode === 'string' ? body.barcode.trim() || null : body.barcode;
      if (barcode) {
        const existing = await prisma.food.findUnique({ where: { barcode } });
        if (existing && existing.id !== id) {
          if (existing.creatorId === editorId) {
            return reply.status(409).send({
              error: 'Ez a vonalkód már egy saját ételedhez van rendelve.',
            });
          }
          return reply.status(409).send({
            error: `Már létezik étel ezzel a vonalkóddal (${barcode}).`,
          });
        }
      }
      (body as { barcode?: string | null }).barcode = barcode;
    }

    const { components, isPrepared, source: unusedSource, ...rest } = body;
    void unusedSource;

    const updated = await prisma.food.update({
      where: { id },
      data: {
        ...rest,
        ...(isPrepared !== undefined ? { isPrepared } : {}),
      },
    });

    if (components && isPrepared) {
      await prisma.foodComponent.deleteMany({ where: { foodId: id } });
      await prisma.foodComponent.createMany({
        data: components.map((c, i) => ({
          foodId: id,
          name: c.name,
          amountG: c.amountG,
          kcal: c.kcal,
          protein: c.protein,
          carbs: c.carbs,
          fat: c.fat,
          fiber: c.fiber ?? undefined,
          sugar: c.sugar ?? undefined,
          sortOrder: c.sortOrder ?? i,
        })),
      });
    } else if (isPrepared === false) {
      await prisma.foodComponent.deleteMany({ where: { foodId: id } });
    }

    await prisma.foodEditLog.create({ data: { foodId: id, userId: editorId } });
    return reply.send(
      (await prisma.food.findUnique({
        where: { id },
        include: { components: { orderBy: { sortOrder: 'asc' } } },
      })) ?? updated,
    );
  });

  // POST /foods/:id/vote
  fastify.post('/:id/vote', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { value } = VoteSchema.parse(req.body);
    const prisma = (fastify as any).prisma;

    const food = await prisma.food.findUnique({ where: { id } });
    if (!food) return reply.status(404).send({ error: 'Étel nem található.' });
    if (food.status === 'BANNED') return reply.status(400).send({ error: 'Tiltott ételen nem szavazhatsz.' });

    const userId = user.userId ?? user.id;

    const existing = await prisma.vote.findUnique({
      where: { userId_foodId: { userId, foodId: id } },
    });

    if (existing) {
      if (existing.value === value) {
        await prisma.vote.delete({ where: { id: existing.id } });
        const { score, status } = await recalcScore(prisma, id);
        return reply.send({ action: 'removed', score, status, myVote: null });
      } else {
        await prisma.vote.update({ where: { id: existing.id }, data: { value } });
        const { score, status } = await recalcScore(prisma, id);
        return reply.send({ action: 'changed', score, status, myVote: value });
      }
    }

    await prisma.vote.create({ data: { userId, foodId: id, value } });
    const { score, status } = await recalcScore(prisma, id);

    const reputationDelta = value === 1 ? 1 : -1;
    await prisma.user.update({
      where: { id: food.creatorId },
      data: { reputation: { increment: reputationDelta } },
    });

    const creator = await prisma.user.findUnique({ where: { id: food.creatorId } });
    const earnedExpertBadge = (creator?.reputation ?? 0) >= 10;

    return reply.send({ action: 'added', score, status, myVote: value, earnedExpertBadge });
  });

  // GET /:id
  fastify.get('/:id', {
    preHandler: [authenticate],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const prisma = (fastify as any).prisma;

    const userId = user.userId ?? user.id;
    const food = await prisma.food.findUnique({
      where: { id },
      include: {
        creator: { select: { username: true, reputation: true } },
        _count: { select: { votes: true } },
        votes: { where: { userId }, select: { value: true } },
        components: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!food) return reply.status(404).send({ error: 'Nem található.' });

    const score = await getScore(prisma, id);
    const myVote = food.votes[0]?.value ?? null;
    const fav = await prisma.foodFavorite.findUnique({
      where: { userId_foodId: { userId, foodId: id } },
    });

    return reply.send({
      ...food,
      score,
      myVote,
      votes: undefined,
      isFavorite: !!fav,
      origin: resolveOrigin(food, false),
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VERIFY_THRESHOLD = 2;
const BAN_THRESHOLD = -3;

async function seedCreatorUpvote(prisma: any, foodId: string, creatorId: string) {
  const existing = await prisma.vote.findUnique({
    where: { userId_foodId: { userId: creatorId, foodId } },
  });
  if (existing) return;
  await prisma.vote.create({ data: { userId: creatorId, foodId, value: 1 } });
  await recalcScore(prisma, foodId);
}

async function getScore(prisma: any, foodId: string): Promise<number> {
  const agg = await prisma.vote.aggregate({
    where: { foodId },
    _sum: { value: true },
  });
  return agg._sum.value ?? 0;
}

async function recalcScore(
  prisma: any,
  foodId: string,
): Promise<{ score: number; status: string }> {
  const score = await getScore(prisma, foodId);

  let newStatus = 'UNVERIFIED';
  if (score >= VERIFY_THRESHOLD) newStatus = 'VERIFIED';
  else if (score <= BAN_THRESHOLD) newStatus = 'BANNED';

  await prisma.food.update({
    where: { id: foodId },
    data: { status: newStatus },
  });

  return { score, status: newStatus };
}
