import { watchlistStateSchema } from '@hth/contracts';
import { watchlistRequest } from '../watchlist-http-client';
export async function getWatchlist(signal?: AbortSignal) {
  return watchlistStateSchema.parse(await watchlistRequest('GET', signal));
}
