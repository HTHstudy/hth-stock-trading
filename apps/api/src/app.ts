import { processHealthSchema } from '@hth/shared';
import Fastify from 'fastify';

export function createApp(logLevel = 'silent') {
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

  return app;
}
