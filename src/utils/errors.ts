import type { ErrorRequestHandler } from 'express';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
    return;
  }
  // lock_not_available: could not get the drop lock within lock_timeout
  if (err?.code === '55P03') {
    res.status(503).json({ error: { code: 'BUSY', message: 'Server is busy, please retry' } });
    return;
  }
  // invalid_text_representation: e.g. malformed UUID
  if (err?.code === '22P02') {
    res.status(400).json({ error: { code: 'INVALID_ID', message: 'Malformed identifier' } });
    return;
  }
  if (typeof err?.message === 'string' && err.message.includes('timeout exceeded when trying to connect')) {
    res.status(503).json({ error: { code: 'BUSY', message: 'Server is busy, please retry' } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};
