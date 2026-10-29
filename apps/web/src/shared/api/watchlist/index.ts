import { getWatchlist } from './endpoints/get-watchlist';
import { saveWatchlist } from './endpoints/save-watchlist';
export const WATCHLIST_API = { get: getWatchlist, save: saveWatchlist };
