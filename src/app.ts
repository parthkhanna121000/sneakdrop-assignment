import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { router } from './routes';
import { errorHandler } from './utils/errors';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Let a plain browser frontend (any origin) call the API.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Keep the raw bytes: the webhook HMAC must be computed over exactly what was sent.
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  // Plain-JS frontend (public/) served by the same server => same origin, no CORS or build step.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
