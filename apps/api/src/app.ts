import {
  paperStrategyHistorySchema,
  paperEquityHistorySchema,
  observationJobsSchema,
  paperStrategyHistoryQuerySchema,
  watchlistStateSchema,
  watchlistUpdateSchema,
  observationListSchema,
  observationReportSchema,
  dashboardStateSchema,
  processHealthSchema,
  paperDashboardStateSchema,
  paperStopAcknowledgementSchema,
  ownerLoginSchema,
  ownerSessionSchema,
  paperStrategyUpdateSchema,
  paperStrategyAcknowledgementSchema,
} from '@hth/contracts';
import Fastify from 'fastify';
import { z } from 'zod';
import type { DashboardService } from './dashboard-service.js';
import type { BacktestReports } from './backtest-reports.js';
import type { PaperDashboard } from './paper-dashboard.js';
import type { OwnerAuth } from './owner-auth.js';
import type { WatchlistStore } from './watchlist-store.js';
import type { ObservationReports } from './observation-reports.js';

export function createApp(
  logLevel = 'silent',
  dashboard?: DashboardService,
  origins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4000', 'http://127.0.0.1:4000'],
  reports?: BacktestReports,
  paper?: PaperDashboard,
  owner?: OwnerAuth,
  observations?: ObservationReports,
  watchlist?: WatchlistStore,
) {
  const app = Fastify({
    logger: {
      level: logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-tossinvest-account"]'],
      serializers: {
        req: (request: { id: string; method: string }) => ({ id: request.id, method: request.method }),
      },
    },
  });

  app.setErrorHandler((_error, request, reply) => {
    request.log.error({ code: 'INTERNAL_ERROR', requestId: request.id }, 'Request failed');
    void reply.code(500).send({ error: { code: 'INTERNAL_ERROR', requestId: request.id } });
  });

  app.get('/health/live', () =>
    processHealthSchema.parse({
      status: 'ok',
      service: 'api',
      mode: 'paper',
      executionEnabled: false,
      scope: 'process-only',
    }),
  );

  app.addHook('onRequest', async (request, reply) => {
    const privateRoute = ['/v1/dashboard', '/v1/backtests', '/v1/paper', '/v1/observations', '/v1/watchlist'].some(
      (path) => request.url.startsWith(path),
    );
    if (!privateRoute && !request.url.startsWith('/v1/auth')) return;
    reply.header('Cache-Control', 'no-store, private');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    const allowedHost = origins.some((origin) => new URL(origin).host === request.headers.host);
    const allowedOrigin = !request.headers.origin || origins.includes(request.headers.origin);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
    if (!local || !allowedHost || !allowedOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: { code: 'LOCAL_ACCESS_ONLY' } });
    }
    if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-hth-dashboard'] !== '1') {
      return reply.code(403).send({ error: { code: 'LOCAL_ACCESS_ONLY' } });
    }
    if (privateRoute) {
      const session = owner?.read(request.headers.cookie);
      if (!session?.configured) return reply.code(503).send({ error: { code: 'OWNER_NOT_CONFIGURED' } });
      if (!session.authenticated) return reply.code(401).send({ error: { code: 'OWNER_LOGIN_REQUIRED' } });
    }
  });
  app.get('/v1/auth/session', (request, reply) => {
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    return ownerSessionSchema.parse(
      owner?.read(request.headers.cookie) ?? { configured: false, authenticated: false, expiresAt: null },
    );
  });
  app.post('/v1/auth/login', { bodyLimit: 2048 }, async (request, reply) => {
    const input = ownerLoginSchema.safeParse(request.body);
    if (!input.success || !z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!owner) return reply.code(503).send({ error: { code: 'OWNER_NOT_CONFIGURED' } });
    try {
      const result = await owner.login(input.data.password);
      reply.header('Set-Cookie', result.cookie);
      return ownerSessionSchema.parse(result.session);
    } catch (error) {
      const code =
        error instanceof Error && ['OWNER_RATE_LIMITED', 'OWNER_NOT_CONFIGURED'].includes(error.message)
          ? error.message
          : 'OWNER_LOGIN_FAILED';
      if (code === 'OWNER_RATE_LIMITED') reply.header('Retry-After', '900');
      return reply
        .code(code === 'OWNER_RATE_LIMITED' ? 429 : code === 'OWNER_NOT_CONFIGURED' ? 503 : 401)
        .send({ error: { code } });
    }
  });
  app.post('/v1/auth/logout', (request, reply) => {
    if (
      !z.object({}).strict().safeParse(request.body).success ||
      !z.object({}).strict().safeParse(request.query).success
    )
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (owner) reply.header('Set-Cookie', owner.logout(request.headers.cookie));
    return ownerSessionSchema.parse({
      configured: Boolean(owner?.read().configured),
      authenticated: false,
      expiresAt: null,
    });
  });
  app.get('/v1/paper/equity', async (request, reply) => {
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!paper) return reply.code(503).send({ error: { code: 'PAPER_DASHBOARD_DISABLED' } });
    try {
      return paperEquityHistorySchema.parse(await paper.equityHistory());
    } catch {
      return reply.code(503).send({ error: { code: 'PAPER_EQUITY_UNAVAILABLE' } });
    }
  });
  app.get('/v1/paper/strategies/:id/history', async (request, reply) => {
    const params = z
      .object({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/) })
      .strict()
      .safeParse(request.params);
    const query = paperStrategyHistoryQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!paper) return reply.code(503).send({ error: { code: 'PAPER_DASHBOARD_DISABLED' } });
    try {
      return paperStrategyHistorySchema.parse(await paper.strategyHistory(params.data.id, query.data));
    } catch (error) {
      if (error instanceof Error && error.message === 'PAPER_STRATEGY_NOT_FOUND')
        return reply.code(404).send({ error: { code: 'PAPER_STRATEGY_NOT_FOUND' } });
      return reply.code(503).send({ error: { code: 'PAPER_STRATEGY_HISTORY_UNAVAILABLE' } });
    }
  });
  app.post('/v1/paper/strategies/:id', async (request, reply) => {
    const input = paperStrategyUpdateSchema.safeParse(request.body);
    const params = z
      .object({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/) })
      .strict()
      .safeParse(request.params);
    if (!input.success || !params.success || !z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!paper) return reply.code(503).send({ error: { code: 'PAPER_DASHBOARD_DISABLED' } });
    try {
      return paperStrategyAcknowledgementSchema.parse(await paper.updateStrategy(params.data.id, input.data));
    } catch (error) {
      if (
        error instanceof Error &&
        ['PAPER_SOURCE_MISMATCH', 'PAPER_STRATEGY_SOURCE_UNSUPPORTED'].includes(error.message)
      )
        return reply
          .code(error.message === 'PAPER_SOURCE_MISMATCH' ? 409 : 422)
          .send({ error: { code: error.message } });
      const conflict = error instanceof Error && error.message === 'PAPER_STRATEGY_REVISION_CONFLICT';
      return reply
        .code(conflict ? 409 : 503)
        .send({ error: { code: conflict ? 'PAPER_STRATEGY_REVISION_CONFLICT' : 'PAPER_STRATEGY_UPDATE_UNCONFIRMED' } });
    }
  });

  app.get('/v1/watchlist', async (request, reply) => {
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!watchlist) return reply.code(503).send({ error: { code: 'WATCHLIST_UNAVAILABLE' } });
    try {
      return watchlistStateSchema.parse(await watchlist.read());
    } catch {
      return reply.code(503).send({ error: { code: 'WATCHLIST_UNAVAILABLE' } });
    }
  });
  app.post('/v1/watchlist', { bodyLimit: 8192 }, async (request, reply) => {
    const input = watchlistUpdateSchema.safeParse(request.body);
    if (!input.success || !z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!watchlist) return reply.code(503).send({ error: { code: 'WATCHLIST_UNAVAILABLE' } });
    try {
      const result = watchlistStateSchema.parse(await watchlist.save(input.data));
      dashboard?.invalidate();
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'WATCHLIST_REVISION_CONFLICT')
        return reply.code(409).send({ error: { code: 'WATCHLIST_REVISION_CONFLICT' } });
      return reply.code(503).send({
        error: {
          code:
            error instanceof Error && error.message === 'WATCHLIST_BUSY'
              ? 'WATCHLIST_BUSY'
              : 'WATCHLIST_SAVE_UNCONFIRMED',
        },
      });
    }
  });
  app.get('/v1/observations', async (request, reply) => {
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!observations) return reply.code(503).send({ error: { code: 'OBSERVATIONS_UNAVAILABLE' } });
    try {
      return observationListSchema.parse(await observations.list());
    } catch {
      return reply.code(503).send({ error: { code: 'OBSERVATIONS_UNAVAILABLE' } });
    }
  });
  app.get('/v1/observations/jobs', async (request, reply) => {
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!observations) return reply.code(503).send({ error: { code: 'OBSERVATIONS_UNAVAILABLE' } });
    try {
      return observationJobsSchema.parse(await observations.jobs());
    } catch {
      return reply.code(503).send({ error: { code: 'OBSERVATION_JOBS_UNAVAILABLE' } });
    }
  });
  app.get('/v1/observations/:id', async (request, reply) => {
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success || !z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!observations) return reply.code(503).send({ error: { code: 'OBSERVATIONS_UNAVAILABLE' } });
    try {
      return observationReportSchema.parse(await observations.get(params.data.id));
    } catch {
      return reply.code(404).send({ error: { code: 'OBSERVATION_NOT_FOUND' } });
    }
  });
  app.get('/v1/dashboard', () =>
    dashboardStateSchema.parse(
      dashboard?.read() ?? {
        mode: 'paper',
        executionEnabled: false,
        connection: 'disabled',
        refreshing: false,
        canRefresh: false,
        error: null,
        snapshot: null,
      },
    ),
  );

  app.get('/v1/backtests', async (_request, reply) => {
    if (!reports) return reply.code(503).send({ error: { code: 'BACKTEST_REPORTS_DISABLED' } });
    try {
      return await reports.list();
    } catch {
      return reply.code(503).send({ error: { code: 'REPORT_DIRECTORY_UNAVAILABLE' } });
    }
  });
  app.get('/v1/paper', async (request, reply) => {
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!paper)
      return paperDashboardStateSchema.parse({
        status: 'disabled',
        mode: 'paper',
        source: 'unverified',
        executionEnabled: false,
        snapshot: null,
      });
    try {
      return paperDashboardStateSchema.parse(await paper.read());
    } catch {
      return reply.code(503).send({ error: { code: 'PAPER_UNAVAILABLE' } });
    }
  });
  app.post('/v1/paper/stop', async (request, reply) => {
    if (
      !z.object({}).strict().safeParse(request.body).success ||
      !z.object({}).strict().safeParse(request.query).success
    )
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!paper) return reply.code(503).send({ error: { code: 'PAPER_DASHBOARD_DISABLED' } });
    try {
      await paper.stop();
      return paperStopAcknowledgementSchema.parse({ mode: 'paper', executionEnabled: false, stopped: true });
    } catch {
      return reply.code(503).send({ error: { code: 'PAPER_STOP_UNCONFIRMED' } });
    }
  });
  app.get('/v1/backtests/:hash', async (request, reply) => {
    if (!reports) return reply.code(503).send({ error: { code: 'BACKTEST_REPORTS_DISABLED' } });
    const parsed = z
      .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_REPORT_ID' } });
    try {
      return await reports.get(parsed.data.hash);
    } catch {
      return reply.code(404).send({ error: { code: 'REPORT_NOT_FOUND' } });
    }
  });

  app.post('/v1/dashboard/refresh', (request, reply) => {
    if (!z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    if (!dashboard) return reply.code(503).send({ error: { code: 'DASHBOARD_DISABLED' } });
    if (!dashboard.read().canRefresh) return reply.code(429).send({ error: { code: 'REFRESH_NOT_AVAILABLE' } });
    dashboard.refresh();
    return reply.code(202).send(dashboardStateSchema.parse(dashboard.read()));
  });
  app.addHook('onClose', async () => {
    dashboard?.close();
    owner?.close();
    await paper?.close();
  });

  return app;
}
