import { randomUUID } from 'crypto';
import {
  MealPlanSlotSource,
  MealType,
  PrismaClient,
  type MealPlanSlot,
} from '@prisma/client';
import { TIER_LIMITS, getUserTier } from '../../middleware/tierGuard';
import { createLog, deleteLog, deleteLogGroup, parseLocalDate, toDateKey } from '../log/log.service';
import { computeNutrition } from '../recipes/recipes.match.service';
import { upsertPreparedFood } from '../recipes/recipes.service';
import { canAccessMealPlan, listIncomingMealPlanShares } from '../shares/shareAccess';
import { mergeNeeds, normalizeQty, subtractNeeds } from '../pantry/pantry.service';
import { getGenerateQuota } from './mealPlan.quota';
import type { LogSlotInput, UpsertSlotInput } from './mealPlan.schema';

function httpError(statusCode: number, message: string, extra?: Record<string, unknown>) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

export function startOfIsoWeek(ref: Date): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}

function addDays(date: Date, n: number): Date {
  const x = new Date(date);
  x.setDate(x.getDate() + n);
  return x;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

async function assertPlanAccess(prisma: PrismaClient, actorId: string, ownerId: string) {
  if (!(await canAccessMealPlan(prisma, actorId, ownerId))) {
    throw httpError(403, 'Nincs jogosultság ehhez az étkezéstervhez.');
  }
}

const slotInclude = {
  recipe: {
    select: {
      id: true,
      title: true,
      servings: true,
      status: true,
      createdBy: true,
      images: { where: { isPrimary: true }, take: 1, select: { id: true } },
      ingredients: {
        select: {
          foodId: true,
          name: true,
          amountG: true,
          amount: true,
          unit: true,
          food: { select: { id: true, kcal: true, protein: true, carbs: true, fat: true, fiber: true, sugar: true } },
        },
      },
    },
  },
  template: {
    select: {
      id: true,
      name: true,
      userId: true,
      items: { select: { kcal: true, protein: true, carbs: true, fat: true, amount: true, foodName: true, foodId: true } },
    },
  },
  food: {
    select: {
      id: true,
      name: true,
      nameHu: true,
      nameEn: true,
      kcal: true,
      protein: true,
      carbs: true,
      fat: true,
      servingSize: true,
    },
  },
  logs: true,
} as const;

type SlotLoaded = MealPlanSlot & {
  recipe: {
    id: string;
    title: string;
    servings: number;
    status: string;
    createdBy: string;
    images: { id: string }[];
    ingredients: Array<{
      foodId: string | null;
      name: string;
      amountG: number | null;
      amount: number | null;
      unit: string | null;
      food: { id: string; kcal: number; protein: number; carbs: number; fat: number; fiber: number | null; sugar: number | null } | null;
    }>;
  } | null;
  template: {
    id: string;
    name: string;
    userId: string;
    items: Array<{ kcal: number; protein: number; carbs: number; fat: number; amount: number; foodName: string; foodId: string | null }>;
  } | null;
  food: {
    id: string;
    name: string;
    nameHu: string | null;
    nameEn: string | null;
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    servingSize: number | null;
  } | null;
  logs: Array<{ userId: string; logId: string | null; logGroupId: string | null }>;
};

function slotPreview(slot: SlotLoaded, actorId: string) {
  const servings = slot.servings > 0 ? slot.servings : 1;
  let title: string | null = null;
  let kcal: number | null = null;
  let protein: number | null = null;
  let carbs: number | null = null;
  let fat: number | null = null;
  let loggable = false;
  let hasImage = false;
  let imageRevision: string | null = null;

  if (slot.source === 'RECIPE' && slot.recipe) {
    title = slot.recipe.title;
    hasImage = slot.recipe.images.length > 0;
    imageRevision = slot.recipe.images[0]?.id ?? null;
    const foods = slot.recipe.ingredients.map((i) => i.food).filter((f): f is NonNullable<typeof f> => Boolean(f));
    const nutrition = computeNutrition(slot.recipe.ingredients, foods, slot.recipe.servings || 1);
    loggable = Boolean(nutrition && nutrition.matchedCount > 0);
    if (nutrition) {
      kcal = Math.round(nutrition.kcal * servings);
      protein = round1(nutrition.protein * servings);
      carbs = round1(nutrition.carbs * servings);
      fat = round1(nutrition.fat * servings);
    }
  } else if (slot.source === 'TEMPLATE' && slot.template) {
    title = slot.template.name;
    const items = slot.template.items;
    loggable = items.length > 0;
    const totals = items.reduce(
      (acc, i) => ({
        kcal: acc.kcal + i.kcal,
        protein: acc.protein + i.protein,
        carbs: acc.carbs + i.carbs,
        fat: acc.fat + i.fat,
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    );
    kcal = Math.round(totals.kcal * servings);
    protein = round1(totals.protein * servings);
    carbs = round1(totals.carbs * servings);
    fat = round1(totals.fat * servings);
  } else if (slot.source === 'FOOD' && slot.food) {
    title = slot.food.nameHu ?? slot.food.nameEn ?? slot.food.name;
    loggable = true;
    const grams =
      slot.amountG && slot.amountG > 0
        ? slot.amountG
        : (slot.food.servingSize && slot.food.servingSize > 0 ? slot.food.servingSize : 100) * servings;
    const r = grams / 100;
    kcal = Math.round(slot.food.kcal * r);
    protein = round1(slot.food.protein * r);
    carbs = round1(slot.food.carbs * r);
    fat = round1(slot.food.fat * r);
  } else if (slot.source === 'SKIPPED') {
    title = null;
    loggable = false;
  }

  const mine = slot.logs.find((l) => l.userId === actorId);
  const logged = Boolean(mine?.logId || mine?.logGroupId);

  return {
    id: slot.id,
    slotDate: toDateKey(slot.slotDate),
    mealType: slot.mealType,
    source: slot.source,
    recipeId: slot.recipeId,
    templateId: slot.templateId,
    foodId: slot.foodId,
    servings: slot.servings,
    amountG: slot.amountG,
    title,
    kcal,
    protein,
    carbs,
    fat,
    loggable,
    logged,
    hasImage,
    imageRevision,
  };
}

async function listSwitcher(prisma: PrismaClient, actorId: string) {
  const [me, incoming] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorId }, select: { id: true, username: true } }),
    listIncomingMealPlanShares(prisma, actorId),
  ]);
  const plans = [
    { ownerId: actorId, username: me?.username ?? '', isOwn: true, shareId: null as string | null },
    ...incoming.map((row) => ({
      ownerId: row.owner.id,
      username: row.owner.username,
      isOwn: false,
      shareId: row.id,
    })),
  ];
  return plans;
}

export async function getWeekPlan(
  prisma: PrismaClient,
  actorId: string,
  opts: { weekStart?: string; ownerId?: string },
) {
  const ownerId = opts.ownerId || actorId;
  await assertPlanAccess(prisma, actorId, ownerId);

  const weekStart = startOfIsoWeek(opts.weekStart ? parseLocalDate(opts.weekStart) ?? new Date() : new Date());
  const weekEnd = addDays(weekStart, 6);
  const plan = await prisma.mealPlan.findUnique({
    where: { userId_weekStart: { userId: ownerId, weekStart } },
    include: {
      slots: { include: slotInclude, orderBy: [{ slotDate: 'asc' }, { mealType: 'asc' }] },
      user: { select: { id: true, username: true } },
    },
  });

  const owner = plan?.user ?? (await prisma.user.findUnique({
    where: { id: ownerId },
    select: { id: true, username: true },
  }));
  if (!owner) throw httpError(404, 'A felhasználó nem található.');

  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true } });
  const generate = await getGenerateQuota(prisma, actorId, weekStart, actor?.role ?? 'USER');

  return {
    weekStart: toDateKey(weekStart),
    weekEnd: toDateKey(weekEnd),
    owner,
    isOwn: ownerId === actorId,
    plans: await listSwitcher(prisma, actorId),
    slots: (plan?.slots ?? []).map((s) => slotPreview(s as SlotLoaded, actorId)),
    generate,
  };
}

async function ensurePlan(prisma: PrismaClient, ownerId: string, weekStart: Date) {
  return prisma.mealPlan.upsert({
    where: { userId_weekStart: { userId: ownerId, weekStart } },
    create: { userId: ownerId, weekStart },
    update: {},
  });
}

function slotDateInWeek(slotDate: Date, weekStart: Date) {
  const end = addDays(weekStart, 7);
  return slotDate >= weekStart && slotDate < end;
}

export async function upsertSlot(prisma: PrismaClient, actorId: string, data: UpsertSlotInput) {
  const ownerId = data.ownerId || actorId;
  await assertPlanAccess(prisma, actorId, ownerId);

  const slotDate = parseLocalDate(data.slotDate);
  if (!slotDate) throw httpError(400, 'Érvénytelen dátum.');
  const weekStart = startOfIsoWeek(data.weekStart ? parseLocalDate(data.weekStart) ?? slotDate : slotDate);
  if (!slotDateInWeek(slotDate, weekStart)) {
    throw httpError(400, 'A nap nem esik a kiválasztott hétre.');
  }

  if (data.source === 'RECIPE' && data.recipeId) {
    const recipe = await prisma.recipe.findUnique({ where: { id: data.recipeId }, select: { id: true } });
    if (!recipe) throw httpError(404, 'A recept nem található.');
  }
  if (data.source === 'TEMPLATE' && data.templateId) {
    const template = await prisma.mealTemplate.findUnique({
      where: { id: data.templateId },
      select: { id: true, userId: true },
    });
    if (!template) throw httpError(404, 'A sablon nem található.');
    if (template.userId !== actorId && template.userId !== ownerId) {
      throw httpError(403, 'Ez a sablon nem használható ebben a tervben.');
    }
  }
  if (data.source === 'FOOD' && data.foodId) {
    const food = await prisma.food.findUnique({ where: { id: data.foodId }, select: { id: true } });
    if (!food) throw httpError(404, 'Az étel nem található.');
  }

  const plan = await ensurePlan(prisma, ownerId, weekStart);
  const contentChangedKeys = {
    source: data.source as MealPlanSlotSource,
    recipeId: data.source === 'RECIPE' ? data.recipeId ?? null : null,
    templateId: data.source === 'TEMPLATE' ? data.templateId ?? null : null,
    foodId: data.source === 'FOOD' ? data.foodId ?? null : null,
    servings: data.servings ?? 1,
    amountG: data.source === 'FOOD' ? data.amountG ?? null : null,
  };

  const existing = await prisma.mealPlanSlot.findUnique({
    where: {
      planId_slotDate_mealType: { planId: plan.id, slotDate, mealType: data.mealType as MealType },
    },
  });

  const slot = existing
    ? await prisma.mealPlanSlot.update({
        where: { id: existing.id },
        data: contentChangedKeys,
        include: slotInclude,
      })
    : await prisma.mealPlanSlot.create({
        data: {
          planId: plan.id,
          slotDate,
          mealType: data.mealType as MealType,
          ...contentChangedKeys,
        },
        include: slotInclude,
      });

  const changed =
    !existing ||
    existing.source !== contentChangedKeys.source ||
    existing.recipeId !== contentChangedKeys.recipeId ||
    existing.templateId !== contentChangedKeys.templateId ||
    existing.foodId !== contentChangedKeys.foodId ||
    existing.servings !== contentChangedKeys.servings ||
    existing.amountG !== contentChangedKeys.amountG;

  if (existing && changed) {
    await prisma.mealPlanSlotLog.deleteMany({ where: { slotId: slot.id } });
  }

  return slotPreview(slot as SlotLoaded, actorId);
}

async function loadAccessibleSlot(prisma: PrismaClient, actorId: string, slotId: string) {
  const slot = await prisma.mealPlanSlot.findUnique({
    where: { id: slotId },
    include: { ...slotInclude, plan: { select: { userId: true } } },
  });
  if (!slot) throw httpError(404, 'A terv-slot nem található.');
  await assertPlanAccess(prisma, actorId, slot.plan.userId);
  return slot;
}

async function deleteOwnDiaryForSlot(
  prisma: PrismaClient,
  actorId: string,
  receipt: { logId: string | null; logGroupId: string | null } | null | undefined,
) {
  if (!receipt) return;
  try {
    if (receipt.logGroupId) await deleteLogGroup(prisma, receipt.logGroupId, actorId);
    else if (receipt.logId) await deleteLog(prisma, receipt.logId, actorId);
  } catch {
    // napló már törölve
  }
}

export async function deleteSlot(
  prisma: PrismaClient,
  actorId: string,
  slotId: string,
  alsoDiary: boolean,
) {
  const slot = await loadAccessibleSlot(prisma, actorId, slotId);
  const mine = slot.logs.find((l) => l.userId === actorId);
  if (alsoDiary) await deleteOwnDiaryForSlot(prisma, actorId, mine);
  await prisma.mealPlanSlot.delete({ where: { id: slotId } });
  return { ok: true };
}

export async function deleteDay(
  prisma: PrismaClient,
  actorId: string,
  dateStr: string,
  opts: { alsoDiary: boolean; ownerId?: string },
) {
  const ownerId = opts.ownerId || actorId;
  await assertPlanAccess(prisma, actorId, ownerId);
  const slotDate = parseLocalDate(dateStr);
  if (!slotDate) throw httpError(400, 'Érvénytelen dátum.');
  const weekStart = startOfIsoWeek(slotDate);
  const plan = await prisma.mealPlan.findUnique({
    where: { userId_weekStart: { userId: ownerId, weekStart } },
  });
  if (!plan) return { ok: true, deleted: 0 };

  const slots = await prisma.mealPlanSlot.findMany({
    where: { planId: plan.id, slotDate },
    include: { logs: true },
  });
  for (const slot of slots) {
    const mine = slot.logs.find((l) => l.userId === actorId);
    if (opts.alsoDiary) await deleteOwnDiaryForSlot(prisma, actorId, mine);
  }
  const result = await prisma.mealPlanSlot.deleteMany({ where: { planId: plan.id, slotDate } });
  return { ok: true, deleted: result.count };
}

async function assertLogLimit(prisma: PrismaClient, userId: string, dateStr: string, needed: number) {
  const start = parseLocalDate(dateStr);
  if (!start) throw httpError(400, 'Érvénytelen dátum.');
  const end = addDays(start, 1);
  const tier = await getUserTier(prisma, userId);
  if (tier === 'PREMIUM') return;
  const count = await prisma.dailyLog.count({
    where: { userId, createdAt: { gte: start, lt: end } },
  });
  if (count + needed > TIER_LIMITS.FREE.dailyLogs) {
    throw httpError(403, `Napi ${TIER_LIMITS.FREE.dailyLogs} naplóbejegyzés az ingyenes korlát.`, {
      upgradeRequired: true,
      feature: 'unlimited_logs',
      currentCount: count,
      limit: TIER_LIMITS.FREE.dailyLogs,
      needed,
    });
  }
}

async function logRecipeSlot(
  prisma: PrismaClient,
  actorId: string,
  slot: SlotLoaded & { plan: { userId: string } },
  dateStr: string,
  servings: number,
  amountG?: number,
) {
  if (!slot.recipeId) throw httpError(400, 'Ehhez a slothoz nincs recept.');
  const prepared = await upsertPreparedFood(prisma, slot.recipeId);
  const servingG = prepared.servingSize && prepared.servingSize > 0 ? prepared.servingSize : 100;
  const amount =
    amountG != null
      ? Math.max(1, round1(amountG))
      : Math.max(1, round1(servingG * servings));
  await assertLogLimit(prisma, actorId, dateStr, 1);
  const log = await createLog(prisma, actorId, {
    foodId: prepared.id,
    foodName: slot.recipe?.title ?? prepared.name,
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    amount,
    mealType: slot.mealType,
    source: 'RECIPE',
    date: dateStr,
    sourcePreparedFoodId: prepared.id,
  });
  return { logId: log.id as string, logGroupId: null as string | null };
}

async function logTemplateSlot(
  prisma: PrismaClient,
  actorId: string,
  slot: SlotLoaded & { plan: { userId: string } },
  dateStr: string,
  servings: number,
) {
  if (!slot.templateId) throw httpError(400, 'Ehhez a slothoz nincs sablon.');
  const template = await prisma.mealTemplate.findUnique({
    where: { id: slot.templateId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!template) throw httpError(404, 'A sablon nem található.');
  if (template.userId !== actorId && template.userId !== slot.plan.userId) {
    throw httpError(403, 'Ez a sablon nem használható.');
  }
  if (template.items.length === 0) throw httpError(400, 'A sablon üres.');
  await assertLogLimit(prisma, actorId, dateStr, template.items.length);

  const start = parseLocalDate(dateStr);
  if (!start) throw httpError(400, 'Érvénytelen dátum.');
  const groupMap = new Map<string, string>();
  const newGroupIds: string[] = [];
  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const item of template.items) {
      let logGroupId: string | undefined;
      if (item.groupKey) {
        let mapped = groupMap.get(item.groupKey);
        if (!mapped) {
          mapped = randomUUID();
          groupMap.set(item.groupKey, mapped);
          newGroupIds.push(mapped);
        }
        logGroupId = mapped;
      } else if (template.items.length > 1) {
        if (newGroupIds.length === 0) newGroupIds.push(randomUUID());
        logGroupId = newGroupIds[0];
      }
      rows.push(
        await tx.dailyLog.create({
          data: {
            userId: actorId,
            foodId: item.foodId,
            foodName: item.foodName,
            kcal: round1(item.kcal * servings),
            protein: round1(item.protein * servings),
            carbs: round1(item.carbs * servings),
            fat: round1(item.fat * servings),
            fiber: item.fiber != null ? round1(item.fiber * servings) : undefined,
            sugar: item.sugar != null ? round1(item.sugar * servings) : undefined,
            amount: Math.max(1, round1(item.amount * servings)),
            mealType: slot.mealType,
            source: 'MANUAL',
            logGroupId,
            logGroupName: item.groupName ?? (template.items.length > 1 ? template.name : undefined),
            sourcePreparedFoodId: item.sourcePreparedFoodId,
            createdAt: start,
          },
        }),
      );
    }
    return rows;
  });
  return {
    logId: created[0]?.id ?? null,
    logGroupId: newGroupIds[0] ?? created[0]?.logGroupId ?? null,
  };
}

async function logFoodSlot(
  prisma: PrismaClient,
  actorId: string,
  slot: SlotLoaded,
  dateStr: string,
  servings: number,
  amountG?: number,
) {
  if (!slot.foodId || !slot.food) throw httpError(400, 'Ehhez a slothoz nincs étel.');
  const grams =
    amountG ??
    slot.amountG ??
    (slot.food.servingSize && slot.food.servingSize > 0 ? slot.food.servingSize : 100) * servings;
  await assertLogLimit(prisma, actorId, dateStr, 1);
  const log = await createLog(prisma, actorId, {
    foodId: slot.food.id,
    foodName: slot.food.nameHu ?? slot.food.nameEn ?? slot.food.name,
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    amount: Math.max(1, round1(grams)),
    mealType: slot.mealType,
    source: 'MANUAL',
    date: dateStr,
  });
  return { logId: log.id as string, logGroupId: null as string | null };
}

async function deductSlotFromPantry(
  prisma: PrismaClient,
  slot: SlotLoaded & { plan: { userId: string } },
  servings: number,
  amountG?: number,
) {
  const needs: Array<{ key: string; foodId: string | null; name: string; quantity: number; unit: 'g' | 'ml' | 'db' }> = [];
  if (slot.source === 'RECIPE' && slot.recipe) {
    const scale = servings / (slot.recipe.servings || 1);
    for (const ing of slot.recipe.ingredients) {
      if (ing.amountG && ing.amountG > 0) {
        needs.push({ key: '', foodId: ing.foodId, name: ing.name, quantity: ing.amountG * scale, unit: 'g' });
      } else if (ing.amount && ing.amount > 0) {
        const q = normalizeQty(ing.amount * scale, ing.unit);
        needs.push({ key: '', foodId: ing.foodId, name: ing.name, quantity: q.quantity, unit: q.unit });
      }
    }
  } else if (slot.source === 'TEMPLATE' && slot.template) {
    for (const item of slot.template.items) {
      needs.push({
        key: '',
        foodId: item.foodId,
        name: item.foodName,
        quantity: (item.amount || 1) * servings,
        unit: 'g',
      });
    }
  } else if (slot.source === 'FOOD' && slot.food) {
    const grams =
      amountG ??
      slot.amountG ??
      (slot.food.servingSize && slot.food.servingSize > 0 ? slot.food.servingSize : 100) * servings;
    needs.push({
      key: '',
      foodId: slot.food.id,
      name: slot.food.nameHu ?? slot.food.nameEn ?? slot.food.name,
      quantity: grams,
      unit: 'g',
    });
  }
  if (needs.length === 0) return;
  await subtractNeeds(prisma, slot.plan.userId, mergeNeeds(needs));
}

export async function logSlot(
  prisma: PrismaClient,
  actorId: string,
  slotId: string,
  body: LogSlotInput,
) {
  const slot = (await loadAccessibleSlot(prisma, actorId, slotId)) as SlotLoaded & { plan: { userId: string } };
  const dateStr = toDateKey(slot.slotDate);
  const mine = slot.logs.find((l) => l.userId === actorId);
  if (mine?.logId || mine?.logGroupId) {
    const stillThere = mine.logGroupId
      ? await prisma.dailyLog.count({ where: { userId: actorId, logGroupId: mine.logGroupId } })
      : mine.logId
        ? await prisma.dailyLog.count({ where: { id: mine.logId, userId: actorId } })
        : 0;
    if (stillThere > 0) {
      return { ok: true, alreadyLogged: true, slot: slotPreview(slot, actorId) };
    }
  }

  if (slot.source === 'SKIPPED') throw httpError(400, 'Üres slotot nem lehet naplózni.');
  const servings = body.servings ?? slot.servings ?? 1;

  let receipt: { logId: string | null; logGroupId: string | null };
  if (slot.source === 'RECIPE') {
    receipt = await logRecipeSlot(prisma, actorId, slot, dateStr, servings, body.amountG);
  } else if (slot.source === 'TEMPLATE') {
    receipt = await logTemplateSlot(prisma, actorId, slot, dateStr, servings);
  } else if (slot.source === 'FOOD') {
    receipt = await logFoodSlot(prisma, actorId, slot, dateStr, servings, body.amountG);
  } else {
    throw httpError(400, 'Ez a slot nem naplózható.');
  }

  await prisma.mealPlanSlotLog.upsert({
    where: { slotId_userId: { slotId: slot.id, userId: actorId } },
    create: { slotId: slot.id, userId: actorId, logId: receipt.logId, logGroupId: receipt.logGroupId },
    update: { logId: receipt.logId, logGroupId: receipt.logGroupId },
  });

  if (body.deductPantry) {
    await deductSlotFromPantry(prisma, slot, servings, body.amountG);
  }

  const fresh = await prisma.mealPlanSlot.findUnique({
    where: { id: slot.id },
    include: slotInclude,
  });
  return { ok: true, alreadyLogged: false, slot: slotPreview(fresh as SlotLoaded, actorId) };
}

export async function liveMealPlanItems(prisma: PrismaClient, ownerId: string) {
  const weekStart = startOfIsoWeek(new Date());
  const plan = await prisma.mealPlan.findUnique({
    where: { userId_weekStart: { userId: ownerId, weekStart } },
    include: { slots: { include: slotInclude, orderBy: [{ slotDate: 'asc' }, { mealType: 'asc' }] } },
  });
  const slots = (plan?.slots ?? []).filter((s) => s.source !== 'SKIPPED');
  return slots.map((s) => {
    const preview = slotPreview(s as SlotLoaded, ownerId);
    const kcal = preview.kcal != null ? `${preview.kcal} kcal` : '';
    return {
      id: s.id,
      title: preview.title || '—',
      meta: [preview.slotDate, preview.mealType, kcal].filter(Boolean).join(' · '),
      at: s.updatedAt.toISOString(),
    };
  });
}
