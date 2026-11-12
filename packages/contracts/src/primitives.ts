import { z } from 'zod';
export const currencySchema = z.enum(['KRW', 'USD']);
export const decimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/);
export const instantSchema = z.iso.datetime({ offset: true });
