import { randomUUID } from 'crypto';
import { MealType, PrismaClient } from '@prisma/client';
import { TIER_LIMITS, getUserTier } from '../../middleware/tierGuard';
import { CopyLogsInput, CreateLogInput, CreateMealTemplateInput, MealHistoryQuery, UpdateLogInput } from './log.schema';

const DIARY_MEALS = ['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK'] as const;
const FREQUENT_LOOKBACK_DAYS = 30;
const FREQUENT_MIN_DAYS = 3;
const TEMPLATE_LIMIT = 20;

export function parseLocalDate(dateStr: string): Date | null {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localDayRange(dateStr: string): { start: Date; end: Date } | null {
  const start = parseLocalDate(dateStr);
  if (!start) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function addDays(date: Date, n: number): Date {
  const x = new Date(date);
  x.setDate(x.getDate() + n);
  return x;
}

export async function getLogs(
  prisma: PrismaClient,
  userId: string,
  filters: { date?: string; from?: string; to?: string; mealType?: string }
) {
  const where: any = { userId };

  if (filters.date) {
    const range = localDayRange(filters.date);
    if (range) where.createdAt = { gte: range.start, lt: range.end };
  } else if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) {
      const range = localDayRange(filters.from);
      if (range) where.createdAt.gte = range.start;
    }
    if (filters.to) {
      const range = localDayRange(filters.to);
      if (range) where.createdAt.lt = range.end;
    }
  }

  if (filters.mealType) where.mealType = filters.mealType;

  const logs = await prisma.dailyLog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      food: {
        select: {
          brand: true,
          isPrepared: true,
          name: true,
          nameHu: true,
          servingSize: true,
          servingUnit: true,
        },
      },
      sourcePreparedFood: { select: { id: true, name: true, nameHu: true, nameEn: true } },
    },
  });

  // Daily summary
  const summary = logs.reduce(
    (acc, log) => ({
      kcal: acc.kcal + log.kcal,
      protein: acc.protein + log.protein,
      carbs: acc.carbs + log.carbs,
      fat: acc.fat + log.fat,
      fiber: acc.fiber + (log.fiber ?? 0),
      sugar: acc.sugar + (log.sugar ?? 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 }
  );

  const mapped = logs.map(({ food, sourcePreparedFood, ...log }) => ({
    ...log,
    brand: food?.brand ?? null,
    servingSize: food?.servingSize ?? null,
    servingUnit: food?.servingUnit ?? null,
    sourcePreparedFoodName:
      log.logGroupName ||
      sourcePreparedFood?.nameHu ||
      sourcePreparedFood?.nameEn ||
      sourcePreparedFood?.name ||
      null,
  }));

  return { logs: mapped, summary };
}

/** Local calendar day noon — stays inside the day window used by stats/logs filters. */
export function createdAtForDate(date?: string): Date | undefined {
  const start = date ? parseLocalDate(date) : null;
  if (!start) return undefined;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0, 0);
}

export async function createLog(
  prisma: PrismaClient,
  userId: string,
  data: CreateLogInput
) {
  const createdAt = createdAtForDate(data.date);

  // If foodId provided, fetch base nutrition and scale by amount/100
  if (data.foodId) {
    const food = await prisma.food.findUnique({ where: { id: data.foodId } });
    if (food) {
      const ratio = data.amount / 100;
      return prisma.dailyLog.create({
        data: {
          userId,
          foodId: food.id,
          foodName: food.nameHu ?? food.nameEn ?? food.name,
          kcal: Math.round(food.kcal * ratio * 10) / 10,
          protein: Math.round(food.protein * ratio * 10) / 10,
          carbs: Math.round(food.carbs * ratio * 10) / 10,
          fat: Math.round(food.fat * ratio * 10) / 10,
          fiber: food.fiber ? Math.round(food.fiber * ratio * 10) / 10 : undefined,
          sugar: food.sugar ? Math.round(food.sugar * ratio * 10) / 10 : undefined,
          amount: data.amount,
          mealType: data.mealType,
          source: data.source,
          logGroupId: data.logGroupId ?? undefined,
          logGroupName: data.logGroupName ?? undefined,
          sourcePreparedFoodId: data.sourcePreparedFoodId ?? (food.isPrepared ? food.id : undefined),
          ...(createdAt ? { createdAt } : {}),
        },
      });
    }
  }

  // Manual entry
  return prisma.dailyLog.create({
    data: {
      userId,
      foodId: data.foodId,
      foodName: data.foodName,
      kcal: data.kcal,
      protein: data.protein,
      carbs: data.carbs,
      fat: data.fat,
      fiber: data.fiber,
      sugar: data.sugar,
      amount: data.amount,
      mealType: data.mealType,
      source: data.source,
      logGroupId: data.logGroupId ?? undefined,
      logGroupName: data.logGroupName ?? undefined,
      sourcePreparedFoodId: data.sourcePreparedFoodId ?? undefined,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

export async function updateLog(
  prisma: PrismaClient,
  logId: string,
  userId: string,
  data: UpdateLogInput
) {
  const log = await prisma.dailyLog.findUnique({ where: { id: logId } });
  if (!log) throw new Error('Naplóbejegyzés nem található.');
  if (log.userId !== userId) throw new Error('Nincs jogosultsága szerkeszteni ezt a bejegyzést.');

  const update: Record<string, unknown> = {};
  if (data.foodName !== undefined) update.foodName = data.foodName;
  if (data.logGroupName !== undefined) update.logGroupName = data.logGroupName;
  if (data.mealType !== undefined) update.mealType = data.mealType;

  const hasExplicitMacros =
    data.kcal !== undefined ||
    data.protein !== undefined ||
    data.carbs !== undefined ||
    data.fat !== undefined;

  if (data.amount !== undefined && !hasExplicitMacros) {
    const ratio = data.amount / (log.amount || 1);
    const round1 = (n: number) => Math.round(n * 10) / 10;
    update.amount = data.amount;
    update.kcal = round1(log.kcal * ratio);
    update.protein = round1(log.protein * ratio);
    update.carbs = round1(log.carbs * ratio);
    update.fat = round1(log.fat * ratio);
    if (log.fiber != null) update.fiber = round1(log.fiber * ratio);
    if (log.sugar != null) update.sugar = round1(log.sugar * ratio);
  } else {
    if (data.amount !== undefined) update.amount = data.amount;
    if (data.kcal !== undefined) update.kcal = data.kcal;
    if (data.protein !== undefined) update.protein = data.protein;
    if (data.carbs !== undefined) update.carbs = data.carbs;
    if (data.fat !== undefined) update.fat = data.fat;
    if (data.fiber !== undefined) update.fiber = data.fiber;
    if (data.sugar !== undefined) update.sugar = data.sugar;
  }

  return prisma.dailyLog.update({ where: { id: logId }, data: update });
}

export async function deleteLog(prisma: PrismaClient, logId: string, userId: string) {
  const log = await prisma.dailyLog.findUnique({ where: { id: logId } });
  if (!log) throw new Error('Naplóbejegyzés nem található.');
  if (log.userId !== userId) throw new Error('Nincs jogosultsága törölni ezt a bejegyzést.');

  return prisma.dailyLog.delete({ where: { id: logId } });
}

export async function deleteLogGroup(prisma: PrismaClient, logGroupId: string, userId: string) {
  const result = await prisma.dailyLog.deleteMany({
    where: { userId, logGroupId },
  });
  if (result.count === 0) {
    throw Object.assign(new Error('Naplócsoport nem található.'), { statusCode: 404 });
  }
  return result;
}

type HistoryLog = {
  id: string;
  foodId: string | null;
  foodName: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  amount: number;
  mealType: string;
  logGroupId: string | null;
  logGroupName: string | null;
  createdAt: Date;
  sourcePreparedFood: { name: string; nameHu: string | null; nameEn: string | null } | null;
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

function emptyTotals() {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

function summarizeLogs(logs: HistoryLog[], date: string, mealType: string): MealDaySummary {
  const totals = logs.reduce(
    (acc, l) => ({
      kcal: acc.kcal + l.kcal,
      protein: acc.protein + l.protein,
      carbs: acc.carbs + l.carbs,
      fat: acc.fat + l.fat,
    }),
    emptyTotals(),
  );
  const seenGroups = new Set<string>();
  const names: string[] = [];
  let itemCount = 0;
  for (const log of logs) {
    const gid = log.logGroupId;
    if (gid) {
      if (seenGroups.has(gid)) continue;
      seenGroups.add(gid);
      const groupLogs = logs.filter((l) => l.logGroupId === gid);
      const title =
        log.logGroupName ||
        log.sourcePreparedFood?.nameHu ||
        log.sourcePreparedFood?.nameEn ||
        log.sourcePreparedFood?.name ||
        log.foodName;
      names.push(groupLogs.length === 1 ? log.foodName : title);
      itemCount += 1;
    } else {
      names.push(log.foodName);
      itemCount += 1;
    }
  }
  return {
    date,
    mealType,
    totals,
    previewNames: names.slice(0, 3),
    itemCount,
  };
}

function mealSignature(logs: HistoryLog[]): string {
  return logs
    .map((l) => (l.foodId || l.foodName).toLowerCase())
    .sort()
    .join('\n');
}

export async function getMealHistory(
  prisma: PrismaClient,
  userId: string,
  query: MealHistoryQuery,
) {
  const before = parseLocalDate(query.before);
  if (!before) throw Object.assign(new Error('Érvénytelen dátum.'), { statusCode: 400 });

  const windowDays = query.days ?? 14;
  const lookbackDays = Math.max(windowDays, FREQUENT_LOOKBACK_DAYS);
  const rangeStart = addDays(before, -lookbackDays);
  const yesterdayKey = toDateKey(addDays(before, -1));

  const mealTypes = query.mealType ? [query.mealType] : [...DIARY_MEALS];

  const logs = (await prisma.dailyLog.findMany({
    where: {
      userId,
      mealType: { in: mealTypes as MealType[] },
      createdAt: { gte: rangeStart, lt: before },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      sourcePreparedFood: { select: { name: true, nameHu: true, nameEn: true } },
    },
  })) as HistoryLog[];

  const byMealDate = new Map<string, HistoryLog[]>();
  for (const log of logs) {
    const key = `${log.mealType}|${toDateKey(log.createdAt)}`;
    const list = byMealDate.get(key);
    if (list) list.push(log);
    else byMealDate.set(key, [log]);
  }

  const slots: Record<string, MealSlotHistory> = {};

  for (const mealType of mealTypes) {
    const days: MealDaySummary[] = [];
    let yesterday: MealDaySummary | null = null;
    let lastFilled: MealDaySummary | null = null;

    for (let i = 1; i <= windowDays; i++) {
      const dateKey = toDateKey(addDays(before, -i));
      const dayLogs = byMealDate.get(`${mealType}|${dateKey}`);
      if (!dayLogs?.length) continue;
      const summary = summarizeLogs(dayLogs, dateKey, mealType);
      days.push(summary);
      if (dateKey === yesterdayKey) yesterday = summary;
      if (!lastFilled) lastFilled = summary;
    }

    const freqMap = new Map<string, { dates: Set<string>; latestDate: string }>();
    for (let i = 1; i <= FREQUENT_LOOKBACK_DAYS; i++) {
      const dateKey = toDateKey(addDays(before, -i));
      const dayLogs = byMealDate.get(`${mealType}|${dateKey}`);
      if (!dayLogs?.length) continue;
      const sig = mealSignature(dayLogs);
      const entry = freqMap.get(sig);
      if (entry) entry.dates.add(dateKey);
      else freqMap.set(sig, { dates: new Set([dateKey]), latestDate: dateKey });
    }

    let frequent: (MealDaySummary & { times: number }) | null = null;
    for (const { dates, latestDate } of freqMap.values()) {
      if (dates.size < FREQUENT_MIN_DAYS) continue;
      if (!frequent || dates.size > frequent.times) {
        const dayLogs = byMealDate.get(`${mealType}|${latestDate}`) ?? [];
        frequent = { ...summarizeLogs(dayLogs, latestDate, mealType), times: dates.size };
      }
    }

    slots[mealType] = { yesterday, lastFilled, days, frequent };
  }

  return { before: query.before, days: windowDays, slots };
}

export async function copyLogs(prisma: PrismaClient, userId: string, data: CopyLogsInput) {
  const targetRange = localDayRange(data.date);
  const createdAt = createdAtForDate(data.date);
  if (!targetRange || !createdAt) {
    throw Object.assign(new Error('Érvénytelen dátum.'), { statusCode: 400 });
  }

  const snapshots = data.templateId
    ? await snapshotsFromTemplate(prisma, userId, data)
    : await snapshotsFromDay(prisma, userId, data);

  if (snapshots.length === 0) {
    throw Object.assign(new Error('Nincs kiválasztott tétel a másoláshoz.'), { statusCode: 400 });
  }

  await assertCopyLimit(prisma, userId, targetRange, snapshots.length);
  return insertCopiedLogs(prisma, userId, data.mealType, createdAt, snapshots);
}

type CopySnapshot = {
  foodId: string | null;
  foodName: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sugar: number | null;
  amount: number;
  groupKey: string | null;
  logGroupName: string | null;
  sourcePreparedFoodId: string | null;
};

type CopySelection = {
  copyAll?: boolean;
  items?: { type: 'log' | 'group'; id: string }[];
};

function pickBySelection<T extends { id: string; logGroupId?: string | null; groupKey?: string | null }>(
  rows: T[],
  selection: CopySelection,
  groupField: 'logGroupId' | 'groupKey',
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const selected: T[] = [];
  const seen = new Set<string>();
  const push = (row: T) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    selected.push(row);
  };
  if (selection.copyAll) {
    for (const row of rows) push(row);
    return selected;
  }
  for (const item of selection.items ?? []) {
    if (item.type === 'log') {
      const row = byId.get(item.id);
      if (row) push(row);
    } else {
      for (const row of rows) {
        if (row[groupField] === item.id) push(row);
      }
    }
  }
  return selected;
}

async function snapshotsFromDay(
  prisma: PrismaClient,
  userId: string,
  data: CopyLogsInput,
): Promise<CopySnapshot[]> {
  if (!data.sourceDate || !data.sourceMealType) {
    throw Object.assign(new Error('sourceDate és sourceMealType kötelező.'), { statusCode: 400 });
  }
  if (data.date === data.sourceDate && data.mealType === data.sourceMealType) {
    throw Object.assign(new Error('Nem másolható ugyanarra a napra és étkezésre.'), {
      statusCode: 400,
    });
  }
  const sourceRange = localDayRange(data.sourceDate);
  if (!sourceRange) {
    throw Object.assign(new Error('Érvénytelen dátum.'), { statusCode: 400 });
  }
  const sourceLogs = await prisma.dailyLog.findMany({
    where: {
      userId,
      mealType: data.sourceMealType,
      createdAt: { gte: sourceRange.start, lt: sourceRange.end },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (sourceLogs.length === 0) {
    throw Object.assign(new Error('Nincs másolható étkezés a forrásnapon.'), { statusCode: 404 });
  }
  return pickBySelection(sourceLogs, data, 'logGroupId').map((log) => ({
    foodId: log.foodId,
    foodName: log.foodName,
    kcal: log.kcal,
    protein: log.protein,
    carbs: log.carbs,
    fat: log.fat,
    fiber: log.fiber,
    sugar: log.sugar,
    amount: log.amount,
    groupKey: log.logGroupId,
    logGroupName: log.logGroupName,
    sourcePreparedFoodId: log.sourcePreparedFoodId,
  }));
}

async function snapshotsFromTemplate(
  prisma: PrismaClient,
  userId: string,
  data: CopyLogsInput,
): Promise<CopySnapshot[]> {
  const template = await prisma.mealTemplate.findFirst({
    where: { id: data.templateId, userId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!template) {
    throw Object.assign(new Error('A sablon nem található.'), { statusCode: 404 });
  }
  const picked = pickBySelection(template.items, data, 'groupKey');
  return picked.map((item) => ({
    foodId: item.foodId,
    foodName: item.foodName,
    kcal: item.kcal,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
    fiber: item.fiber,
    sugar: item.sugar,
    amount: item.amount,
    groupKey: item.groupKey,
    logGroupName: item.groupName,
    sourcePreparedFoodId: item.sourcePreparedFoodId,
  }));
}

async function assertCopyLimit(
  prisma: PrismaClient,
  userId: string,
  targetRange: { start: Date; end: Date },
  needed: number,
) {
  const tier = await getUserTier(prisma, userId);
  const currentCount = await prisma.dailyLog.count({
    where: { userId, createdAt: { gte: targetRange.start, lt: targetRange.end } },
  });
  if (tier !== 'PREMIUM' && currentCount + needed > TIER_LIMITS.FREE.dailyLogs) {
    throw Object.assign(
      new Error(`Napi ${TIER_LIMITS.FREE.dailyLogs} naplóbejegyzés az ingyenes korlát.`),
      {
        statusCode: 403,
        upgradeRequired: true,
        feature: 'unlimited_logs',
        currentCount,
        limit: TIER_LIMITS.FREE.dailyLogs,
        needed,
      },
    );
  }
}

async function insertCopiedLogs(
  prisma: PrismaClient,
  userId: string,
  mealType: CopyLogsInput['mealType'],
  createdAt: Date,
  snapshots: CopySnapshot[],
) {
  const groupMap = new Map<string, string>();
  const newGroupIds: string[] = [];

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const log of snapshots) {
      let logGroupId: string | undefined;
      if (log.groupKey) {
        let mapped = groupMap.get(log.groupKey);
        if (!mapped) {
          mapped = randomUUID();
          groupMap.set(log.groupKey, mapped);
          newGroupIds.push(mapped);
        }
        logGroupId = mapped;
      }
      rows.push(
        await tx.dailyLog.create({
          data: {
            userId,
            foodId: log.foodId,
            foodName: log.foodName,
            kcal: log.kcal,
            protein: log.protein,
            carbs: log.carbs,
            fat: log.fat,
            fiber: log.fiber,
            sugar: log.sugar,
            amount: log.amount,
            mealType,
            source: 'MANUAL',
            logGroupId,
            logGroupName: log.logGroupName,
            sourcePreparedFoodId: log.sourcePreparedFoodId,
            createdAt,
          },
        }),
      );
    }
    return rows;
  });

  return {
    logs: created,
    logIds: created.map((l) => l.id),
    groupIds: newGroupIds,
  };
}

function mapTemplate(template: {
  id: string;
  name: string;
  mealType: string;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
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
    groupName: string | null;
    sourcePreparedFoodId: string | null;
    sourcePreparedFood: { name: string; nameHu: string | null; nameEn: string | null } | null;
  }>;
}) {
  const totals = template.items.reduce(
    (acc, i) => ({
      kcal: acc.kcal + i.kcal,
      protein: acc.protein + i.protein,
      carbs: acc.carbs + i.carbs,
      fat: acc.fat + i.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const seen = new Set<string>();
  const previewNames: string[] = [];
  let itemCount = 0;
  for (const item of template.items) {
    if (item.groupKey) {
      if (seen.has(item.groupKey)) continue;
      seen.add(item.groupKey);
      itemCount += 1;
      previewNames.push(
        item.groupName ||
          item.sourcePreparedFood?.nameHu ||
          item.sourcePreparedFood?.nameEn ||
          item.sourcePreparedFood?.name ||
          item.foodName,
      );
    } else {
      itemCount += 1;
      previewNames.push(item.foodName);
    }
  }
  return {
    id: template.id,
    name: template.name,
    mealType: template.mealType,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    totals,
    previewNames: previewNames.slice(0, 3),
    itemCount,
    items: template.items.map((i) => ({
      id: i.id,
      foodId: i.foodId,
      foodName: i.foodName,
      kcal: i.kcal,
      protein: i.protein,
      carbs: i.carbs,
      fat: i.fat,
      fiber: i.fiber,
      sugar: i.sugar,
      amount: i.amount,
      sortOrder: i.sortOrder,
      groupKey: i.groupKey,
      groupName: i.groupName,
      sourcePreparedFoodId: i.sourcePreparedFoodId,
      sourcePreparedFoodName:
        i.groupName ||
        i.sourcePreparedFood?.nameHu ||
        i.sourcePreparedFood?.nameEn ||
        i.sourcePreparedFood?.name ||
        null,
    })),
  };
}

const templateInclude = {
  items: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      sourcePreparedFood: { select: { name: true, nameHu: true, nameEn: true } },
    },
  },
};

export async function listMealTemplates(
  prisma: PrismaClient,
  userId: string,
  mealType?: string,
) {
  const templates = await prisma.mealTemplate.findMany({
    where: { userId, ...(mealType ? { mealType: mealType as MealType } : {}) },
    orderBy: { updatedAt: 'desc' },
    include: templateInclude,
  });
  return { templates: templates.map(mapTemplate) };
}

export async function createMealTemplate(
  prisma: PrismaClient,
  userId: string,
  data: CreateMealTemplateInput,
) {
  const count = await prisma.mealTemplate.count({ where: { userId } });
  if (count >= TEMPLATE_LIMIT) {
    throw Object.assign(new Error(`Legfeljebb ${TEMPLATE_LIMIT} mentett étkezés tárolható.`), {
      statusCode: 403,
      limit: TEMPLATE_LIMIT,
      currentCount: count,
    });
  }

  const sourceRange = localDayRange(data.sourceDate);
  if (!sourceRange) {
    throw Object.assign(new Error('Érvénytelen dátum.'), { statusCode: 400 });
  }
  const sourceLogs = await prisma.dailyLog.findMany({
    where: {
      userId,
      mealType: data.sourceMealType,
      createdAt: { gte: sourceRange.start, lt: sourceRange.end },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (sourceLogs.length === 0) {
    throw Object.assign(new Error('Nincs másolható étkezés a forrásnapon.'), { statusCode: 404 });
  }
  const selected = pickBySelection(sourceLogs, data, 'logGroupId');
  if (selected.length === 0) {
    throw Object.assign(new Error('Nincs kiválasztott tétel a mentéshez.'), { statusCode: 400 });
  }

  const groupMap = new Map<string, string>();
  const created = await prisma.mealTemplate.create({
    data: {
      userId,
      name: data.name,
      mealType: data.mealType,
      items: {
        create: selected.map((log, index) => {
          let groupKey: string | undefined;
          if (log.logGroupId) {
            let mapped = groupMap.get(log.logGroupId);
            if (!mapped) {
              mapped = randomUUID();
              groupMap.set(log.logGroupId, mapped);
            }
            groupKey = mapped;
          }
          return {
            foodId: log.foodId,
            foodName: log.foodName,
            kcal: log.kcal,
            protein: log.protein,
            carbs: log.carbs,
            fat: log.fat,
            fiber: log.fiber,
            sugar: log.sugar,
            amount: log.amount,
            sortOrder: index,
            groupKey,
            groupName: log.logGroupName,
            sourcePreparedFoodId: log.sourcePreparedFoodId,
          };
        }),
      },
    },
    include: templateInclude,
  });
  return mapTemplate(created);
}

export async function deleteMealTemplate(prisma: PrismaClient, userId: string, id: string) {
  const existing = await prisma.mealTemplate.findFirst({ where: { id, userId } });
  if (!existing) {
    throw Object.assign(new Error('A sablon nem található.'), { statusCode: 404 });
  }
  await prisma.mealTemplate.delete({ where: { id } });
  return { message: 'Sablon törölve.' };
}
