import type { Express } from 'express';
import { getBrowserContext } from './engines/playwright';

export function registerHealthEndpoint(app: Express): void {
  app.get('/health', (_req, res) => {
    const ctx = getBrowserContext();
    res.json({
      status: 'ok',
      browser: ctx !== null ? 'running' : 'not_started',
      timestamp: new Date().toISOString(),
    });
  });
}
