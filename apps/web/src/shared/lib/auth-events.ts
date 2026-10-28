export const OWNER_EXPIRED_EVENT = 'hth-owner-expired';
export function notifyUnauthorized(status: number) {
  if (status === 401) window.dispatchEvent(new Event(OWNER_EXPIRED_EVENT));
}
