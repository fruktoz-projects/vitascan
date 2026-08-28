import { z } from 'zod';

export const CreateLogSchema = z.object({
  foodId: z.string().uuid().optional(), // optional: can log without DB food entry
  foodName: z.string().min(1).max(100),
  kcal: z.number().min(0),
  protein: z.number().min(0),
  carbs: z.number().min(0),
  fat: z.number().min(0),
  fiber: z.number().min(0).optional(),
  sugar: z.number().min(0).optional(),
  amount: z.number().min(1, 'Mennyiség min. 1g'),
  mealType: z.enum(['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK', 'OTHER']).default('OTHER'),
  source: z.enum(['MANUAL', 'SCAN', 'SEARCH', 'AI', 'RECIPE']).default('MANUAL'),
  /** YYYY-MM-DD — ha meg van adva, a bejegyzés erre a napra kerül (nem a mai createdAt-re). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dátum formátum: YYYY-MM-DD').optional(),
  logGroupId: z.string().uuid().optional().nullable(),
  logGroupName: z.string().min(1).max(100).optional().nullable(),
  sourcePreparedFoodId: z.string().uuid().optional().nullable(),
});

export const LogQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dátum formátum: YYYY-MM-DD').optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mealType: z.enum(['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK', 'OTHER']).optional(),
});

export const UpdateLogSchema = z.object({
  foodName: z.string().min(1).max(100).optional(),
  logGroupName: z.string().min(1).max(100).optional().nullable(),
  amount: z.number().min(1, 'Mennyiség min. 1g').optional(),
  mealType: z.enum(['BREAKFAST', 'TIZORAI', 'LUNCH', 'UZSONNA', 'DINNER', 'SNACK', 'OTHER']).optional(),
  kcal: z.number().min(0).optional(),
  protein: z.number().min(0).optional(),
  carbs: z.number().min(0).optional(),
  fat: z.number().min(0).optional(),
  fiber: z.number().min(0).optional().nullable(),
  sugar: z.number().min(0).optional().nullable(),
}).refine(
  (d) => Object.keys(d).length > 0,
  { message: 'Legalább egy mezőt meg kell adni.' }
);

export const MealTypeEnum = z.enum([
  'BREAKFAST',
  'TIZORAI',
  'LUNCH',
  'UZSONNA',
  'DINNER',
  'SNACK',
  'OTHER',
]);

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dátum formátum: YYYY-MM-DD');

export const MealHistoryQuerySchema = z.object({
  before: DateStr,
  days: z.coerce.number().int().min(1).max(90).optional(),
  mealType: MealTypeEnum.optional(),
});

export const CopyLogsSchema = z
  .object({
    date: DateStr,
    mealType: MealTypeEnum,
    sourceDate: DateStr.optional(),
    sourceMealType: MealTypeEnum.optional(),
    templateId: z.string().uuid().optional(),
    copyAll: z.boolean().optional(),
    items: z
      .array(
        z.object({
          type: z.enum(['log', 'group']),
          id: z.string().uuid(),
        }),
      )
      .optional(),
  })
  .refine((d) => d.copyAll === true || (d.items && d.items.length > 0), {
    message: 'copyAll vagy items megadása kötelező.',
  })
  .refine((d) => !!d.templateId || (!!d.sourceDate && !!d.sourceMealType), {
    message: 'templateId vagy sourceDate+sourceMealType megadása kötelező.',
  });

export const MealTemplateQuerySchema = z.object({
  mealType: MealTypeEnum.optional(),
});

export const CreateMealTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    mealType: MealTypeEnum,
    sourceDate: DateStr,
    sourceMealType: MealTypeEnum,
    copyAll: z.boolean().optional(),
    items: z
      .array(
        z.object({
          type: z.enum(['log', 'group']),
          id: z.string().uuid(),
        }),
      )
      .optional(),
  })
  .refine((d) => d.copyAll === true || (d.items && d.items.length > 0), {
    message: 'copyAll vagy items megadása kötelező.',
  });

export type CreateLogInput = z.infer<typeof CreateLogSchema>;
export type UpdateLogInput = z.infer<typeof UpdateLogSchema>;
export type MealHistoryQuery = z.infer<typeof MealHistoryQuerySchema>;
export type CopyLogsInput = z.infer<typeof CopyLogsSchema>;
export type CreateMealTemplateInput = z.infer<typeof CreateMealTemplateSchema>;
