import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';
import { BrokerError } from '../errors.js';
import { tokenDto } from './dto.js';

export type TossFetch = (url: string, init: RequestInit) => Promise<Response>;
export type RateGroup =
  'AUTH' | 'ACCOUNT' | 'ASSET' | 'STOCK' | 'MARKET_DATA' | 'MARKET_DATA_CHART' | 'MARKET_INFO' | 'ORDER_INFO';
export type ReadPath =
  | '/api/v1/accounts'
  | '/api/v1/holdings'
  | '/api/v1/stocks'
  | '/api/v1/prices'
  | '/api/v1/candles'
  | '/api/v1/buying-power'
  | '/api/v1/exchange-rate'
  | '/api/v1/market-calendar/KR'
  | '/api/v1/market-calendar/US';

export interface TossOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: TossFetch;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const baseUrl = 'https://openapi.tossinvest.com';
const initialLimits: Record<RateGroup, number> = {
  AUTH: 5,
  ACCOUNT: 1,
  ASSET: 5,
  STOCK: 5,
  MARKET_DATA: 15,
  MARKET_DATA_CHART: 20,
  MARKET_INFO: 3,
  ORDER_INFO: 3,
};

export function createTransport(options: TossOptions) {
  if (
    !options.clientId.trim() ||
    !options.clientSecret.trim() ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000))
  ) {
    throw new BrokerError('INVALID_INPUT');
  }
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const wait =
    options.wait ??
    (async (milliseconds: number) => {
      await sleep(milliseconds, undefined, { signal: options.signal });
    });
  const slots = new Map<RateGroup, { next: number; interval: number; queue: Promise<void> }>();
  let token: { value: string; refreshAt: number } | undefined;
  let pendingToken: Promise<string> | undefined;

  function checkCancelled() {
    if (options.signal?.aborted) throw new BrokerError('CANCELLED');
  }

  async function pause(milliseconds: number) {
    checkCancelled();
    try {
      if (milliseconds > 0) await wait(Math.ceil(milliseconds));
    } catch {
      throw new BrokerError('CANCELLED');
    }
    checkCancelled();
  }

  function slot(group: RateGroup) {
    let state = slots.get(group);
    if (!state) {
      state = { next: 0, interval: Math.ceil(1000 / initialLimits[group]), queue: Promise.resolve() };
      slots.set(group, state);
    }
    return state;
  }

  async function acquire(group: RateGroup) {
    const state = slot(group);
    const previous = state.queue;
    let release = () => {};
    state.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const delay = Math.max(0, state.next - now());
      if (delay > 30_000) throw new BrokerError('RATE_LIMITED');
      await pause(delay);
      state.next = now() + state.interval;
    } finally {
      release();
    }
  }

  function observe(group: RateGroup, headers: Headers) {
    const state = slot(group);
    const limit = Number(headers.get('X-RateLimit-Limit'));
    if (Number.isFinite(limit) && limit > 0) state.interval = Math.max(state.interval, Math.ceil(1000 / limit));
    if (headers.get('X-RateLimit-Remaining') === '0') {
      const reset = Number(headers.get('X-RateLimit-Reset'));
      if (Number.isFinite(reset) && reset > 0) state.next = Math.max(state.next, now() + reset * 1000);
    }
  }

  async function send(path: string, init: RequestInit, group: RateGroup) {
    await acquire(group);
    checkCancelled();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 5000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const response = await fetcher(`${baseUrl}${path}`, { ...init, signal, redirect: 'error' });
      observe(group, response.headers);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (signal.aborted) throw new BrokerError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
        if (response.ok) throw new BrokerError('INVALID_RESPONSE', response.status);
      }
      return { response, payload };
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      if (options.signal?.aborted) throw new BrokerError('CANCELLED');
      if (timeout.aborted) throw new BrokerError('TIMEOUT');
      throw new BrokerError('NETWORK_ERROR');
    }
  }

  function failure(response: Response) {
    const rawId = response.headers.get('X-Request-Id');
    const requestId = rawId && /^[A-Za-z0-9_.-]{1,128}$/.test(rawId) ? rawId : null;
    const status = response.status;
    const code =
      status === 401
        ? 'AUTHENTICATION_FAILED'
        : status === 403
          ? 'PERMISSION_DENIED'
          : status === 429
            ? 'RATE_LIMITED'
            : status >= 500
              ? 'UPSTREAM_UNAVAILABLE'
              : 'UPSTREAM_REJECTED';
    return new BrokerError(code, status, requestId);
  }

  async function issueToken() {
    const issuedAt = now();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    const { response, payload } = await send(
      '/oauth2/token',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      'AUTH',
    );
    if (!response.ok) throw failure(response);
    const parsed = tokenDto.safeParse(payload);
    if (!parsed.success) throw new BrokerError('INVALID_RESPONSE');
    const ttl = parsed.data.expires_in * 1000;
    const refreshAt = issuedAt + ttl - Math.min(60_000, ttl * 0.1);
    if (refreshAt <= now()) throw new BrokerError('AUTHENTICATION_FAILED');
    token = { value: parsed.data.access_token, refreshAt };
    return token.value;
  }

  async function getToken() {
    checkCancelled();
    if (token && token.refreshAt > now()) return token.value;
    pendingToken ??= issueToken();
    const pending = pendingToken;
    try {
      return await pending;
    } finally {
      if (pendingToken === pending) pendingToken = undefined;
    }
  }

  async function get<T>(
    path: ReadPath,
    group: RateGroup,
    schema: z.ZodType<T>,
    query = new URLSearchParams(),
    account?: string,
  ): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const accessToken = await getToken();
      let result: Awaited<ReturnType<typeof send>>;
      try {
        result = await send(
          `${path}${query.size ? `?${query}` : ''}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              ...(account === undefined ? {} : { 'X-Tossinvest-Account': account }),
            },
          },
          group,
        );
      } catch (error) {
        if (error instanceof BrokerError && ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) && attempt < 2) {
          await pause(1000 * 2 ** attempt + Math.floor(random() * 250));
          continue;
        }
        throw error;
      }
      const { response, payload } = result;
      if (response.ok) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new BrokerError('INVALID_RESPONSE', response.status);
        return parsed.data;
      }
      if (response.status === 401 && !refreshed && attempt < 2) {
        if (token?.value === accessToken) token = undefined;
        refreshed = true;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = retryAfter === null ? 0 : Number(retryAfter);
        const requiredWait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
        const delay =
          Math.max(requiredWait, slot(group).next - now(), 1000 * 2 ** attempt) + Math.floor(random() * 250);
        slot(group).next = Math.max(slot(group).next, now() + delay);
        if (delay > 30_000) throw failure(response);
        await pause(delay);
        continue;
      }
      throw failure(response);
    }
    throw new BrokerError('UPSTREAM_UNAVAILABLE');
  }

  return { get };
}
