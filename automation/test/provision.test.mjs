import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Cloudflare } from '../cloudflare.mjs';
import { freshSchema, sqliteAdapter } from '../schema.mjs';
import { verifyPublicDNS } from '../public-dns.mjs';
import { txtValue, txtPresentation } from '../dns-content.mjs';
import { domainName, names, inspect, provision, initialize, ensureEmailDNS, STATE_KEY } from '../provision.mjs';
import { setupRequest, deploymentMeta, sha256, ensureSettings } from '../../mail-worker/src/oneclick/setup.js';
import cryptoUtils from '../../mail-worker/src/utils/crypto-utils.js';

const domain = 'example.com';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const ownerEmail = 'owner@example.net';
const commit = 'c'.repeat(40);
const repository = 'test/cloud-mail';
const workerDir = new URL('../../mail-worker/', import.meta.url).pathname;
const schema = await freshSchema(new URL('../../mail-worker/', import.meta.url));

class FakeCF {
  constructor() {
    this.namespaces = [];
    this.databases = [];
    this.dns = [{ type: 'A', name: domain, content: '192.0.2.1' }];
    this.domains = [];
    this.routes = [];
    this.rules = [];
    this.senders = [];
    this.secrets = [];
    this.settings = null;
    this.routing = { enabled: false };
    this.catchAll = { enabled: false, actions: [{ type: 'drop' }] };
    this.state = null;
    this.db = null;
    this.writes = [];
    this.emails = [];
    this.ownerVerified = true;
    this.deploys = 0;
  }
  async list(path, params = {}) {
    if (path === '/zones') return [{ id: zoneId, name: domain, status: 'active', account: { id: accountId } }];
    if (path.endsWith('/storage/kv/namespaces')) return structuredClone(this.namespaces);
    if (path.endsWith('/workers/domains')) return structuredClone(this.domains);
    if (path.endsWith('/workers/routes')) return structuredClone(this.routes);
    if (path.endsWith('/dns_records')) return structuredClone(this.dns.filter(item => !params.name || item.name === params.name));
    if (path.endsWith('/email/routing/rules')) return structuredClone(this.rules);
    if (path.endsWith('/email/routing/addresses')) return [{ email: ownerEmail, verified: this.ownerVerified ? '2026-01-01' : null }];
    if (path.endsWith('/email/sending/subdomains')) return structuredClone(this.senders);
    if (path.endsWith('/d1/database')) return structuredClone(this.databases);
    throw new Error(`Unhandled list: ${path}`);
  }
  async value() { return structuredClone(this.state); }
  async putValue(a, id, key, state) {
    assert.equal(a, accountId); assert.equal(id, this.namespaces[0].id); assert.equal(key, STATE_KEY);
    this.writes.push('state'); this.state = structuredClone(state);
  }
  async get(path) {
    if (path.endsWith('/settings')) return structuredClone(this.settings);
    if (path.endsWith('/secrets')) return structuredClone(this.secrets);
    if (path.endsWith('/email/routing/rules/catch_all')) return structuredClone(this.catchAll);
    if (path.endsWith('/email/routing')) return structuredClone(this.routing);
    if (path.endsWith('/email/routing/dns')) return [
      ...[1, 2, 3].map(i => ({ type: 'MX', name: '@', content: `route${i}.mx.cloudflare.net`, priority: i * 10 })),
      { type: 'TXT', name: '@', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      { type: 'TXT', name: `cf2024-1._domainkey.${domain}`, content: 'v=DKIM1; p=routing' }
    ];
    if (path.includes('/email/sending/subdomains/') && path.endsWith('/dns')) return [
      ...[1, 2, 3].map(i => ({ type: 'MX', name: `cf-bounce.${domain}`, content: `route${i}.mx.cloudflare.net`, priority: i * 10 })),
      { type: 'TXT', name: `cf-bounce.${domain}`, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      { type: 'TXT', name: `cf-bounce._domainkey.${domain}`, content: 'v=DKIM1; p=sending' },
      { type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=reject;' }
    ];
    throw new Error(`Unhandled get: ${path}`);
  }
  async request(method, path, body) {
    this.writes.push(`${method} ${path}`);
    if (method === 'POST' && path.endsWith('/storage/kv/namespaces')) {
      const item = { id: 'd'.repeat(32), title: body.title }; this.namespaces.push(item); return { result: item };
    }
    if (method === 'POST' && path.endsWith('/d1/database')) {
      const item = { uuid: '11111111-1111-4111-8111-111111111111', name: body.name };
      this.databases.push(item); this.db = new DatabaseSync(':memory:');
      this.db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID');
      return { result: item };
    }
    if (path.endsWith('/dns_records')) { this.dns.push(structuredClone(body)); return { result: { id: 'dns' } }; }
    if (path.endsWith('/workers/domains')) { this.domains.push(structuredClone(body)); return { result: body }; }
    if (path.endsWith('/secrets')) { this.secrets.push({ name: body.name }); return { result: {} }; }
    if (path.endsWith('/email/sending/subdomains')) {
      const item = { tag: 'e'.repeat(32), name: body.name, enabled: true }; this.senders.push(item); return { result: item };
    }
    if (path.endsWith('/email/routing/dns')) { this.routing.enabled = true; return { result: this.routing }; }
    if (path.endsWith('/rules/catch_all')) { this.catchAll = structuredClone(body); return { result: body }; }
    if (path.endsWith('/email/sending/send')) {
      assert.deepEqual(body.to, [ownerEmail]);
      this.emails.push(body); return { result: this.sendResult || { queued: [ownerEmail] } };
    }
    throw new Error(`Unhandled write: ${method} ${path}`);
  }
  async query(a, id, sql, params = []) {
    assert.equal(a, accountId); assert.equal(id, this.databases[0].uuid);
    this.writes.push('sql');
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return [{ success: true, results: this.db.prepare(sql).all(...params) }];
    if (!params.length) this.db.exec(sql);
    else this.db.prepare(sql).run(...params);
    return [{ success: true, results: [] }];
  }
  async deploy(config) {
    this.deploys++;
    this.settings = { bindings: [
      { name: 'ONECLICK_DEPLOYMENT_ID', text: config.vars.ONECLICK_DEPLOYMENT_ID },
      { name: 'db', id: config.d1_databases[0].database_id },
      { name: 'kv', namespace_id: config.kv_namespaces[0].id }, { name: 'email', type: 'send_email' }
    ] };
  }
  options(extra = {}) {
    return { cf: this, accountId, domain, repository, commit, ownerEmail, apply: true, schema, workerDir,
      deployWorker: config => this.deploy(config),
      probe: async () => ({ deploymentId: this.state.deploymentId, schemaReady: true,
        activated: !!this.db.prepare('SELECT activated FROM _cloudmail_deployment').get().activated }),
      verifyDNS: async records => { assert.equal(records.some(record => record.name === `_dmarc.${domain}`), true); },
      log: () => {}, ...extra };
  }
}

test('domain validation rejects shell, URL, wildcard, IP, mixed case, whitespace and path input', () => {
  assert.equal(domainName(domain), domain);
  for (const value of ['Example.com', ' example.com', 'example.com ', '*.example.com', 'https://example.com', 'example.com/a', 'a.com;echo', '127.0.0.1', 'a..com', '-a.com', 'a.com\n', '${{secrets.X}}', 'xn--.com']) {
    assert.throws(() => domainName(value), undefined, value);
  }
});

test('read-only plan never creates resources or DNS records', async () => {
  const cf = new FakeCF();
  const result = await provision(cf.options({ apply: false }));
  assert.equal(result.mode, 'plan'); assert.deepEqual(cf.writes, []); assert.equal(cf.deploys, 0);
});

test('existing website, mail provider, catch-all and unverified owner each fail before writes', async () => {
  const cases = [
    cf => cf.dns.push({ type: 'CNAME', name: `mail.${domain}`, content: 'old.example.net' }),
    cf => cf.dns.push({ type: 'MX', name: domain, content: 'mx.legacy.example' }),
    cf => cf.dns.push({ type: 'TXT', name: domain, content: 'v=spf1 include:legacy.example -all' }),
    cf => cf.catchAll = { enabled: true, actions: [{ type: 'worker', value: ['old-worker'] }] },
    cf => cf.settings = { bindings: [] },
    cf => cf.namespaces.push({ id: 'd'.repeat(32), title: names(domain).kv }),
    cf => cf.rules.push({ enabled: true, matchers: [{ type: 'literal' }] }),
    cf => cf.routes.push({ pattern: '*.example.com/*', script: 'old-worker' }),
    cf => cf.ownerVerified = false
  ];
  for (const modify of cases) {
    const cf = new FakeCF(); modify(cf);
    await assert.rejects(provision(cf.options())); assert.deepEqual(cf.writes, []);
  }
});

test('new project gets isolated resources, reserved admin, closed signup, routing and activation email', async () => {
  const cf = new FakeCF();
  const result = await provision(cf.options({ forward: true }));
  assert.equal(result.receiveTest, 'pending_external_test'); assert.equal(cf.deploys, 1);
  assert.equal(result.publicDNS, 'verified_on_two_public_resolvers');
  assert.equal(cf.namespaces.length, 1); assert.equal(cf.databases.length, 1);
  assert.equal(cf.db.prepare('SELECT email FROM user').get().email, 'admin@example.com');
  assert.equal(cf.db.prepare('SELECT register FROM setting').get().register, 1);
  assert.deepEqual({ ...cf.db.prepare('SELECT forward_email,rule_email,rule_type FROM setting').get() },
    { forward_email: ownerEmail, rule_email: 'admin@example.com', rule_type: 1 });
  assert.equal(cf.catchAll.actions[0].value[0], names(domain).worker);
  assert.deepEqual(cf.dns[0], { type: 'A', name: domain, content: '192.0.2.1' });
  assert.equal(cf.dns.filter(item => item.type === 'MX' && item.name === domain).length, 3);
  assert.equal(cf.dns.filter(item => item.type === 'MX' && item.name === `cf-bounce.${domain}`).length, 3);
  assert.match(cf.emails[0].text, /https:\/\/mail.example.com\/setup/);
  const code = cf.emails[0].text.match(/\n([a-f0-9]{64})\n/)[1];
  assert.equal(cf.db.prepare('SELECT activation_hash FROM _cloudmail_deployment').get().activation_hash, await sha256(code));
  assert.equal(cf.db.prepare('SELECT password FROM user').get().password.includes(code), false);
});

test('activation requires the owner to be queued or delivered; rejected recipients can resume', async () => {
  for (const sendResult of [{ permanent_bounces: [ownerEmail] }, { suppressed_recipients: [ownerEmail] }, { queued: [] }]) {
    const cf = new FakeCF(); cf.sendResult = sendResult;
    await assert.rejects(provision(cf.options()), /not queued or delivered/);
    assert.equal(cf.state.configured, undefined);
    cf.sendResult = { delivered: [ownerEmail] };
    await provision(cf.options());
    assert.equal(cf.state.configured, true); assert.equal(cf.deploys, 1);
  }
});

test('DNS propagation must pass before activation is requested', async () => {
  const cf = new FakeCF();
  await assert.rejects(provision(cf.options({ verifyDNS: async () => { throw new Error('DNS pending'); } })), /DNS pending/);
  assert.equal(cf.emails.length, 0); assert.equal(cf.state.configured, undefined);
  await provision(cf.options());
  assert.equal(cf.emails.length, 1); assert.equal(cf.deploys, 1);
});

test('unhealthy Worker never enables Catch-all or requests activation', async () => {
  const cf = new FakeCF();
  await assert.rejects(provision(cf.options({ probe: async () => { throw new Error('Settings cache not ready'); } })), /Settings cache not ready/);
  assert.equal(cf.catchAll.enabled, false); assert.equal(cf.emails.length, 0);
  await provision(cf.options());
  assert.equal(cf.catchAll.enabled, true); assert.equal(cf.deploys, 1);
});

test('runtime settings bootstrap uses the original refresh callback and preserves existing settings', async () => {
  const cache = new Map(); let refreshes = 0;
  const env = { kv: { get: async key => cache.get(key) || null } };
  const setting = { title: domain, resendTokens: {}, emailPrefixFilter: '', forwardStatus: 1 };
  const refresh = async context => {
    assert.equal(context.env, env); context.set('setting', setting);
    cache.set('setting:', setting); refreshes++;
  };
  assert.equal(await ensureSettings(env, { schema_ready: 0 }, refresh), false); assert.equal(refreshes, 0);
  assert.equal(await ensureSettings(env, { schema_ready: 1 }, refresh), true); assert.equal(refreshes, 1);
  setting.title = 'User customized title';
  assert.equal(await ensureSettings(env, { schema_ready: 1 }, refresh), true); assert.equal(refreshes, 1);
  assert.equal(cache.get('setting:').title, 'User customized title');
});

test('settings bootstrap waits for KV visibility rather than claiming health after a write', async () => {
  let visible = false; let refreshes = 0;
  const env = { kv: { get: async () => visible ? {title: domain} : null } };
  const refresh = async () => { refreshes++; };
  assert.equal(await ensureSettings(env, {schema_ready: 1}, refresh), false);
  assert.equal(refreshes, 1);
  visible = true;
  assert.equal(await ensureSettings(env, {schema_ready: 1}, refresh), true);
  assert.equal(refreshes, 1);
});

test('public DNS verifier checks split TXT, MX priority, both resolvers and rejects duplicate SPF', async () => {
  const records = [
    { type: 'MX', name: domain, content: 'route1.mx.cloudflare.net', priority: 10 },
    { type: 'TXT', name: domain, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
    { type: 'TXT', name: `cf-bounce._domainkey.${domain}`, content: 'v=DKIM1; p=abcdef' },
    { type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=reject;' }
  ];
  const resolver = () => ({
    resolveMx: async () => [{ exchange: 'ROUTE1.MX.CLOUDFLARE.NET.', priority: 10 }],
    resolveTxt: async name => records.filter(record => record.type === 'TXT' && record.name === name)
      .map(record => [txtValue(record.content).slice(0, 10), txtValue(record.content).slice(10)])
  });
  const first = resolver(); const second = resolver();
  await verifyPublicDNS(records, { resolvers: [first, second], attempts: 1 });
  second.resolveMx = async () => [{ exchange: 'route1.mx.cloudflare.net', priority: 20 }];
  await assert.rejects(verifyPublicDNS(records, { resolvers: [first, second], attempts: 1 }), /Public MX/);
  second.resolveMx = first.resolveMx;
  const txt = second.resolveTxt;
  second.resolveTxt = async name => [...await txt(name), ...(name === domain ? [['v=spf1 -all']] : [])];
  await assert.rejects(verifyPublicDNS(records, { resolvers: [first, second], attempts: 1 }), /Public MX/);
});

test('repeat deployment does not duplicate resources, reset passwords or rotate JWT', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  const password = cf.db.prepare('SELECT password FROM user').get().password;
  await provision(cf.options());
  assert.equal(cf.deploys, 1); assert.equal(cf.namespaces.length, 1); assert.equal(cf.databases.length, 1);
  assert.equal(cf.secrets.length, 1); assert.equal(cf.emails.length, 2);
  assert.equal(cf.db.prepare('SELECT password FROM user').get().password, password);
  cf.db.exec('UPDATE _cloudmail_deployment SET activated=1');
  await provision(cf.options()); assert.equal(cf.emails.length, 2);
});

test('changing source commit or recorded D1 binding is rejected', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  await assert.rejects(provision(cf.options({ commit: 'f'.repeat(40) })), /original workflow/);
  cf.settings.bindings.find(item => item.name === 'db').id = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(provision(cf.options()), /D1 binding/);
});

async function stoppedBeforeInitialization() {
  const cf = new FakeCF();
  const query = cf.query.bind(cf);
  cf.query = async (...args) => {
    if (args[2].startsWith('CREATE TABLE _cloudmail_deployment')) throw new Error('Stopped before application initialization');
    return query(...args);
  };
  await assert.rejects(provision(cf.options()), /Stopped before application initialization/);
  cf.query = query;
  return cf;
}

test('D1 reserved table is retained and empty never-deployed resources can resume corrected source', async () => {
  const cf = await stoppedBeforeInitialization();
  assert.equal(cf.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 1);
  const dbId = cf.state.databaseId; const kvId = cf.state.kvId;
  await provision(cf.options({ commit: 'f'.repeat(40) }));
  assert.equal(cf.state.commit, 'f'.repeat(40)); assert.equal(cf.state.initialCommit, commit);
  assert.equal(cf.state.databaseId, dbId); assert.equal(cf.state.kvId, kvId);
  assert.equal(cf.databases.length, 1); assert.equal(cf.namespaces.length, 1); assert.equal(cf.deploys, 1);
  assert.equal(cf.db.prepare("SELECT name FROM sqlite_master WHERE name='_cf_KV'").get().name, '_cf_KV');
});

test('corrected-source resume never adopts initialized, unknown-table, deployed or domain-bound resources', async () => {
  const modifications = [
    cf => cf.db.exec('CREATE TABLE customer_data (id INTEGER)'),
    cf => cf.db.exec('CREATE TABLE _cf_custom (id INTEGER)'),
    cf => cf.state.workerDeployed = true,
    cf => cf.state.sendingRequested = true,
    cf => cf.domains.push({hostname: `mail.${domain}`,service: names(domain).worker})
  ];
  for (const modify of modifications) {
    const cf = await stoppedBeforeInitialization(); modify(cf);
    await assert.rejects(provision(cf.options({ commit: 'f'.repeat(40) })), /original workflow/);
    assert.equal(cf.state.commit, commit); assert.equal(cf.deploys, 0); assert.equal(cf.secrets.length, 0);
  }
});

test('completed project is not redeployed or silently unpaused on a repeat run', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  cf.db.exec('UPDATE _cloudmail_deployment SET activated=1');
  cf.catchAll.enabled = false;
  cf.routing.enabled = false;
  const start = cf.writes.length;
  await provision(cf.options());
  assert.equal(cf.catchAll.enabled, false); assert.equal(cf.routing.enabled, false);
  assert.equal(cf.deploys, 1);
  assert.equal(cf.writes.slice(start).some(item => /^(POST|PUT)/.test(item)), false);
});

test('interrupted sending-domain creation is reconciled only with persisted intent', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  delete cf.state.sendingId;
  await inspect(cf, { accountId, domain, repository, ownerEmail });
  cf.state.sendingRequested = false;
  await assert.rejects(inspect(cf, { accountId, domain, repository, ownerEmail }), /already has/);
});

test('DNS helper refuses unrelated names and conflicting records; existing DMARC is preserved', async () => {
  const cf = new FakeCF();
  await assert.rejects(ensureEmailDNS(cf, zoneId, domain, [{ type: 'TXT', name: 'other.example.net', content: 'x' }], 'sending'));
  cf.dns.push({ type: 'TXT', name: `cf-bounce.${domain}`, content: 'v=spf1 include:old.example -all' });
  await assert.rejects(ensureEmailDNS(cf, zoneId, domain, [{ type: 'TXT', name: `cf-bounce.${domain}`, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }], 'sending'));
  cf.dns.push({ type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=reject; rua=mailto:security@example.com' });
  await ensureEmailDNS(cf, zoneId, domain, [{ type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=none;' }], 'sending');
  assert.equal(cf.writes.length, 0);
});

test('Cloudflare apex CNAME is preserved while routing MX/TXT is added; subdomain CNAME still blocks', async () => {
  const cf = new FakeCF();
  cf.dns = [
    { type: 'CNAME', name: domain, content: 'website.example.net', proxied: true },
    { type: 'CNAME', name: `www.${domain}`, content: 'website.example.net', proxied: true }
  ];
  const before = structuredClone(cf.dns);
  await provision(cf.options());
  assert.deepEqual(cf.dns.slice(0, 2), before);
  assert.equal(cf.dns.filter(record => record.type === 'MX' && record.name === domain).length, 3);
  assert.equal(cf.dns.some(record => record.type === 'TXT' && record.name === domain && /^v=spf1\b/.test(txtValue(record.content))), true);
  cf.dns.push({ type: 'CNAME', name: `cf-bounce.${domain}`, content: 'another.example.net' });
  await assert.rejects(ensureEmailDNS(cf, zoneId, domain,
    [{ type: 'TXT', name: `cf-bounce.${domain}`, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }], 'sending'), /CNAME conflict/);
});

test('TXT presentation handles split strings and RFC escapes without weakening malformed-input checks', () => {
  assert.equal(txtValue('"v=spf1 " "include:_spf.mx.cloudflare.net ~all"'), 'v=spf1 include:_spf.mx.cloudflare.net ~all');
  assert.equal(txtValue('"a\\032b\\034c\\092d"'), 'a b"c\\d');
  const long = 'v=DKIM1; p=' + 'A'.repeat(600);
  assert.equal(txtValue(txtPresentation(long)), long);
  assert.equal(txtValue(txtPresentation('a "quoted" \\ value')), 'a "quoted" \\ value');
  assert.equal((txtPresentation(long).match(/"[^\"]*"/g) || []).length, 3);
  for (const invalid of ['"unterminated', '"first"junk', 'broken"quote', '"\\999"', '"trailing\\']) {
    assert.throws(() => txtValue(invalid));
  }
});

test('quoted API SPF and DMARC values are compared semantically and never replaced', async () => {
  const cf = new FakeCF();
  cf.dns.push({ type: 'TXT', name: domain, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
  const policy = '"v=DMARC1; p=reject; " "rua=mailto:security@example.com"';
  cf.dns.push({ type: 'TXT', name: `_dmarc.${domain}`, content: policy });
  await inspect(cf, { accountId, domain, repository, ownerEmail });
  await ensureEmailDNS(cf, zoneId, domain,
    [{ type: 'TXT', name: domain, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }], 'routing');
  await ensureEmailDNS(cf, zoneId, domain,
    [{ type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=none;' }], 'sending');
  assert.equal(cf.writes.length, 0); assert.equal(cf.dns.at(-1).content, policy);
  cf.dns[1].content = '"v=spf1 include:other.example -all"';
  await assert.rejects(inspect(cf, { accountId, domain, repository, ownerEmail }), /SPF requires manual review/);
});

test('public DNS checks decode quoted expected values while DNS writes use valid character strings', async () => {
  const cf = new FakeCF();
  const record = {type: 'TXT', name: `cf-bounce._domainkey.${domain}`, content: '"v=DKIM1; " "p=abcdef"'};
  await ensureEmailDNS(cf, zoneId, domain, [record], 'sending');
  assert.equal(cf.dns.at(-1).content, '"v=DKIM1; p=abcdef"');
  const resolver = {resolveTxt: async () => [['v=DKIM1; ', 'p=abcdef']]};
  await verifyPublicDNS([record], {resolvers: [resolver, resolver], attempts: 1});
});

test('all MX hosts explicitly returned by CF can coexist but unrelated existing MX is protected', async () => {
  const cf = new FakeCF();
  const records = [
    {type: 'MX', name: `cf-bounce.${domain}`, content: 'bounce-a.cloudflare-smtp.org', priority: 10},
    {type: 'MX', name: `cf-bounce.${domain}`, content: 'bounce-b.cloudflare-smtp.org', priority: 20}
  ];
  await ensureEmailDNS(cf, zoneId, domain, records, 'sending');
  assert.equal(cf.dns.filter(record => record.type === 'MX').length, 2);
  cf.dns.push({type: 'MX', name: `cf-bounce.${domain}`, content: 'old-provider.example', priority: 30});
  await assert.rejects(ensureEmailDNS(cf, zoneId, domain,
    [...records, {type: 'MX', name: `cf-bounce.${domain}`, content: 'bounce-c.cloudflare-smtp.org', priority: 40}], 'sending'), /Existing DNS conflict/);
});

test('foreign database is not initialized and interrupted owned initialization can resume', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  const state = cf.state;
  const oldPassword = cf.db.prepare('SELECT password FROM user').get().password;
  cf.db.exec('UPDATE _cloudmail_deployment SET schema_ready=0');
  await initialize(cf, state, schema, ownerEmail, false);
  assert.equal(cf.db.prepare('SELECT COUNT(*) AS n FROM user').get().n, 1);
  assert.equal(cf.db.prepare('SELECT COUNT(*) AS n FROM setting').get().n, 1);
  assert.equal(cf.db.prepare('SELECT password FROM user').get().password, oldPassword);
  cf.db.exec('DROP TABLE _cloudmail_deployment');
  await assert.rejects(initialize(cf, state, schema, ownerEmail, false), /not empty/);
});

test('activation requires same origin, valid code and password; replay cannot reset admin', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  const env = { db: sqliteAdapter(cf.db), ONECLICK_DOMAIN: domain, ONECLICK_DEPLOYMENT_ID: cf.state.deploymentId };
  const code = cf.emails[0].text.match(/\n([a-f0-9]{64})\n/)[1];
  const meta = await deploymentMeta(env);
  const send = (values = {}, origin = 'https://mail.example.com') => new Request('https://mail.example.com/setup', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, password: 'A strong password 123!', confirm: 'A strong password 123!', ...values })
  });
  const hasher = password => cryptoUtils.hashPassword(password);
  assert.equal((await setupRequest(send({}, 'https://evil.example'), env, meta, hasher)).status, 403);
  assert.equal((await setupRequest(send({ code: 'f'.repeat(64) }), env, meta, hasher)).status, 400);
  assert.equal((await setupRequest(send({ confirm: 'mismatch' }), env, meta, hasher)).status, 400);
  assert.equal((await setupRequest(send(), env, meta, hasher)).status, 303);
  const user = cf.db.prepare('SELECT password,salt FROM user').get();
  assert.equal(await cryptoUtils.verifyPassword('A strong password 123!', user.salt, user.password), true);
  assert.equal((await setupRequest(send({ password: 'replacement password', confirm: 'replacement password' }), env, meta, hasher)).status, 409);
  assert.equal(cf.db.prepare('SELECT password FROM user').get().password, user.password);
  assert.equal((await setupRequest(send(), env, await deploymentMeta(env), hasher)).status, 404);
});

test('expired activation code is rejected and deployment identity must match', async () => {
  const cf = new FakeCF(); await provision(cf.options());
  const env = { db: sqliteAdapter(cf.db), ONECLICK_DOMAIN: domain, ONECLICK_DEPLOYMENT_ID: cf.state.deploymentId };
  cf.db.exec('UPDATE _cloudmail_deployment SET activation_expires=0');
  const code = cf.emails[0].text.match(/\n([a-f0-9]{64})\n/)[1];
  const request = new Request('https://mail.example.com/setup', { method: 'POST',
    headers: { Origin: 'https://mail.example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, password: 'safe password 123', confirm: 'safe password 123' }) });
  assert.equal((await setupRequest(request, env, await deploymentMeta(env), () => { throw new Error('must not hash'); })).status, 400);
  assert.equal(await deploymentMeta({ ...env, ONECLICK_DEPLOYMENT_ID: 'e'.repeat(64) }), null);
});

test('API client does not follow redirects, leak secrets, or ignore later inventory pages', async () => {
  const calls = [];
  const cf = new Cloudflare('private-token', async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ success: true, result: [{ page }], result_info: { total_pages: 2 } });
  });
  assert.deepEqual(await cf.list('/zones'), [{ page: 1 }, { page: 2 }]);
  assert.equal(calls.every(call => call.redirect === 'error'), true);
  const failed = new Cloudflare('private-token', async () => Response.json({ success: false, errors: [{ code: 99, message: 'private-token' }] }, { status: 403 }));
  await assert.rejects(failed.get('/zones'), error => !error.message.includes('private-token') && error.message.includes('99'));
});
