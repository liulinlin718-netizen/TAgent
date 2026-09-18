import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { installAccessControl, resolveAccessConfig } from '../access-control.js';

describe('HTTP request body rejection', () => {
  it('returns a readable rejection for a large body without entering the task handler', async () => {
    const app = new Hono();
    const config = resolveAccessConfig({}, '127.0.0.1', 0);
    // This case exercises upload rejection after 30 prior requests, not the independent rate gate.
    config.requestLimits.external = 40;
    installAccessControl(app, config);
    let handled = 0;
    app.post('/api/agent/run', async c => { handled++; return c.json(await c.req.json()); });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    config.hosts.push(`127.0.0.1:${port}`);
    try {
      for (let index = 0; index < 30; index++) {
        const response = await fetch(`http://127.0.0.1:${port}/api/agent/run`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: index }),
        });
        expect(await response.json()).toEqual({ message: index });
      }
      handled = 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(2 * 1024 * 1024) }), signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get('connection')).toBe('close');
      expect(await response.json()).toMatchObject({ code: 'BODY_TOO_LARGE', accepted: false });
      expect(handled).toBe(0);
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
