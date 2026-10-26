const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function deploymentMeta(env) {
  if (!/^[a-f0-9]{64}$/.test(env.ONECLICK_DEPLOYMENT_ID || '') ||
      !/^[a-z0-9.-]+$/.test(env.ONECLICK_DOMAIN || '')) return null;
  const row = await env.db.prepare('SELECT * FROM _cloudmail_deployment WHERE id=1').first();
  if (!row || row.deployment_id !== env.ONECLICK_DEPLOYMENT_ID || row.domain !== env.ONECLICK_DOMAIN) return null;
  return row;
}

function response(body, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: { ...headers, 'Content-Type': type } });
}

function setupPage(domain) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activate ${domain}</title><style>
*{box-sizing:border-box}body{font:16px system-ui;margin:0;color:#20252a;background:#f5f7f9}main{max-width:440px;margin:8vh auto;padding:24px}
h1{font-size:24px;overflow-wrap:anywhere}label{display:block;margin:20px 0 8px}input,button{width:100%;font:inherit;padding:12px;border:1px solid #9ba5af;border-radius:4px}
button{margin-top:24px;background:#126448;color:white;border:0;cursor:pointer}p{overflow-wrap:anywhere}</style>
<main><h1>${domain}</h1><p>admin@${domain}</p><form method="post" action="/setup" autocomplete="off">
<label for="code">Activation code</label><input id="code" name="code" required pattern="[a-f0-9]{64}" minlength="64" maxlength="64" spellcheck="false" autocomplete="one-time-code">
<label for="password">Password (12-30 characters)</label><input id="password" name="password" type="password" required minlength="12" maxlength="30" autocomplete="new-password">
<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" required minlength="12" maxlength="30" autocomplete="new-password">
<button type="submit">Activate admin</button></form></main></html>`;
}

export async function setupRequest(request, env, meta, hashPassword) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.hostname !== `mail.${env.ONECLICK_DOMAIN}`) return response('Not found', 404);
  if (url.pathname === '/_cloudmail/health') {
    return response(JSON.stringify({ deploymentId: env.ONECLICK_DEPLOYMENT_ID, schemaReady: !!meta?.schema_ready, activated: !!meta?.activated }),
      meta?.schema_ready ? 200 : 503, 'application/json');
  }
  if (url.pathname !== '/setup' || !meta?.schema_ready || meta.activated) return response('Not found', 404);
  if (request.method === 'GET') return response(setupPage(env.ONECLICK_DOMAIN), 200, 'text/html; charset=utf-8');
  if (request.method !== 'POST') return response('Method not allowed', 405);
  if (request.headers.get('Origin') !== url.origin) return response('Origin rejected', 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return response('Invalid form', 415);
  const bytes = await request.body?.getReader();
  if (!bytes) return response('Invalid form', 400);
  let content = '';
  let size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await bytes.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await bytes.cancel(); return response('Form too large', 413); }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  const form = new URLSearchParams(content);
  const code = form.get('code') || '';
  const password = form.get('password') || '';
  if (!/^[a-f0-9]{64}$/.test(code) || password.length < 12 || password.length > 30 || password !== form.get('confirm')) {
    return response('Invalid activation code or password. Passwords must match and contain 12-30 characters.', 400);
  }
  const digest = await sha256(code);
  if (meta.activation_hash !== digest || meta.activation_expires <= Date.now()) return response('Invalid or expired activation code', 400);
  const { salt, hash } = await hashPassword(password);
  const email = `admin@${env.ONECLICK_DOMAIN}`;
  const now = Date.now();
  // Both statements are conditional and transactional: replay/concurrent activation cannot reset a password.
  const result = await env.db.batch([
    env.db.prepare('UPDATE user SET password=?,salt=? WHERE email=? AND EXISTS (SELECT 1 FROM _cloudmail_deployment WHERE id=1 AND activated=0 AND schema_ready=1 AND activation_hash=? AND activation_expires>?)')
      .bind(hash, salt, email, digest, now),
    env.db.prepare('UPDATE _cloudmail_deployment SET activated=1,activation_hash=NULL,activation_expires=NULL WHERE id=1 AND activated=0 AND activation_hash=? AND activation_expires>? AND (SELECT COUNT(*) FROM user WHERE email=?)=1')
      .bind(digest, now, email)
  ]);
  if (result[0]?.meta?.changes !== 1 || result[1]?.meta?.changes !== 1) return response('Activation unavailable', 409);
  return new Response(null, { status: 303, headers: { ...headers, Location: '/login' } });
}
