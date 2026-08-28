export type DiaryLogLike = {
  id: string;
  foodName: string;
  kcal?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  amount?: number | null;
  brand?: string | null;
  logGroupId?: string | null;
  logGroupName?: string | null;
  sourcePreparedFoodId?: string | null;
  sourcePreparedFoodName?: string | null;
  [key: string]: unknown;
};

export type DiaryEntry =
  | { kind: 'single'; log: DiaryLogLike }
  | {
      kind: 'group';
      logGroupId: string;
      title: string;
      logs: DiaryLogLike[];
      totals: { kcal: number; protein: number; carbs: number; fat: number; amount: number };
    };

/** Group consecutive / same-group logs for diary display. */
export function groupDiaryLogs(logs: DiaryLogLike[]): DiaryEntry[] {
  const byGroup = new Map<string, DiaryLogLike[]>();
  const order: string[] = [];
  const singles: DiaryLogLike[] = [];
  const seen = new Set<string>();

  for (const log of logs) {
    const gid = log.logGroupId;
    if (gid) {
      if (!byGroup.has(gid)) {
        byGroup.set(gid, []);
        order.push(`g:${gid}`);
      }
      byGroup.get(gid)!.push(log);
    } else {
      order.push(`s:${log.id}`);
      singles.push(log);
    }
  }

  const singleMap = new Map(singles.map((l) => [l.id, l]));
  const out: DiaryEntry[] = [];

  for (const key of order) {
    if (key.startsWith('g:')) {
      const gid = key.slice(2);
      if (seen.has(gid)) continue;
      seen.add(gid);
      const groupLogs = byGroup.get(gid) ?? [];
      if (groupLogs.length === 0) continue;
      if (groupLogs.length === 1) {
        out.push({ kind: 'single', log: groupLogs[0]! });
        continue;
      }
      const totals = groupLogs.reduce(
        (acc, l) => ({
          kcal: acc.kcal + (l.kcal ?? 0),
          protein: acc.protein + (l.protein ?? 0),
          carbs: acc.carbs + (l.carbs ?? 0),
          fat: acc.fat + (l.fat ?? 0),
          amount: acc.amount + (l.amount ?? 0),
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0, amount: 0 },
      );
      out.push({
        kind: 'group',
        logGroupId: gid,
        title:
          groupLogs[0]?.logGroupName ||
          groupLogs[0]?.sourcePreparedFoodName ||
          groupLogs[0]?.foodName ||
          'Kész étel',
        logs: groupLogs,
        totals,
      });
    } else {
      const id = key.slice(2);
      const log = singleMap.get(id);
      if (log) out.push({ kind: 'single', log });
    }
  }

  return out;
}
