import { watchlistStateSchema, watchlistUpdateSchema } from '@hth/contracts';
import { watchlistRequest } from '../watchlist-http-client';
export async function saveWatchlist(value: unknown) {
  return watchlistStateSchema.parse(await watchlistRequest('POST', undefined, watchlistUpdateSchema.parse(value)));
}
