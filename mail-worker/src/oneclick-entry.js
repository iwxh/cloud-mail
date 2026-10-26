import app from './index.js';
import cryptoUtils from './utils/crypto-utils.js';
import { deploymentMeta, setupRequest } from './oneclick/setup.js';

const unavailable = () => new Response('Mailbox setup is not ready.', { status: 503, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    try {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(/\/+/g, '/');
      // Provisioned projects never expose the legacy JWT-in-URL initialization endpoint.
      if (/^\/(?:api\/)?init(?:\/|$)/i.test(path)) return new Response('Not found', { status: 404 });
      const meta = await deploymentMeta(env);
      if (path === '/setup' || path === '/_cloudmail/health') {
        return setupRequest(request, env, meta, password => cryptoUtils.hashPassword(password));
      }
      if (!meta?.schema_ready || !env.jwt_secret) return unavailable();
      if (!meta.activated) {
        return request.method === 'GET'
          ? new Response(null, { status: 303, headers: { Location: '/setup', 'Cache-Control': 'no-store' } })
          : unavailable();
      }
      return app.fetch(request, env, ctx);
    } catch {
      return unavailable();
    }
  },
  async email(message, env, ctx) {
    const meta = await deploymentMeta(env);
    if (!meta?.schema_ready) { message.setReject('Mailbox setup is not ready'); return; }
    return app.email(message, env, ctx);
  },
  async scheduled(event, env, ctx) {
    const meta = await deploymentMeta(env);
    if (meta?.schema_ready) return app.scheduled(event, env, ctx);
  }
};
