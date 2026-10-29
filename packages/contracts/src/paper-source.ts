import { z } from 'zod';

export const paperDataSourceSchema = z.enum(['unverified', 'synthetic-only', 'toss-readonly']);
export const paperExecutionSourceSchema = paperDataSourceSchema.exclude(['unverified']);
export type PaperDataSource = z.infer<typeof paperDataSourceSchema>;
