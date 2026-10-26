import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII, fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { writeFile, rm, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Cloudflare } from './cloudflare.mjs';
import { freshSchema } from './schema.mjs';
import { verifyPublicDNS } from './public-dns.mjs';

export const STATE_KEY = '_cloudmail_provisioner_v1';
export const APP_VERSION = 1;
const hex32 = /^[a-f0-9]{32}$/i;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');

export function domainName(value) {
  if (typeof value !== 'string' || value !== value.trim().toLowerCase() || value !== domainToASCII(value)) {
    throw new Error('Enter a lowercase ASCII domain only, without spaces or https://. Use punycode for IDNs.');
  }
  const labels = value.split('.');
  if (value.length > 200 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Invalid domain.');
  }
  return value;
}

export function names(domain) {
  const key = hash(domain).slice(0, 20);
  return { worker: `cm-mail-${key}`, kv: `cm-mail-${key}`, hostname: `mail.${domain}` };
}

function assertState(state, accountId, zoneId, domain, repository) {
  if (state?.version !== APP_VERSION || state.domain !== domain || state.accountId !== accountId ||
      state.zoneId !== zoneId || state.repository !== repository || !hex32.test(state.kvId) ||
      !/^[a-f0-9]{64}$/.test(state.deploymentId) || state.worker !== names(domain).worker ||
      state.databaseName !== `cm-db-${hash(domain).slice(0, 20)}-${state.deploymentId.slice(0, 8)}` ||
      (state.databaseId && !uuid.test(state.databaseId)) || (state.sendingId && !hex32.test(state.sendingId))) {
    throw new Error('Resource ownership record does not match. Refusing to adopt existing resources.');
  }
}

function normalizeRecord(record, domain) {
  const name = record.name === '@' ? domain : record.name?.toLowerCase().replace(/\.$/, '');
  if (!name || !['MX', 'TXT'].includes(record.type) || typeof record.content !== 'string') {
    throw new Error('Unexpected email DNS record returned by Cloudflare.');
  }
  return { type: record.type, name, content: record.content, ttl: record.ttl || 1,
    ...(record.type === 'MX' ? { priority: record.priority } : {}) };
}

export function sameRecord(a, b) {
  const content = record => record.type === 'MX' ? record.content.toLowerCase().replace(/\.$/, '') : record.content;
  return a.type === b.type && a.name.toLowerCase().replace(/\.$/, '') === b.name && content(a) === content(b);
}

export async function ensureEmailDNS(cf, zoneId, domain, desired, kind) {
  if (!Array.isArray(desired) || !desired.length) throw new Error('Cloudflare did not return email DNS requirements.');
  const existing = await cf.list(`/zones/${zoneId}/dns_records`);
  for (const value of desired) {
    const record = normalizeRecord(value, domain);
    const allowed = kind === 'routing'
      ? [domain, `cf2024-1._domainkey.${domain}`]
      : [`cf-bounce.${domain}`, `cf-bounce._domainkey.${domain}`, `_dmarc.${domain}`];
    if (!allowed.includes(record.name)) throw new Error(`Email DNS record outside the approved scope: ${record.name}`);
    if (record.type === 'MX' && record.name.includes('_domainkey')) throw new Error('Unexpected email DNS type.');
    const matches = existing.filter(item => item.name.toLowerCase().replace(/\.$/, '') === record.name);
    if (matches.some(item => item.type === 'CNAME')) throw new Error(`CNAME conflict at ${record.name}.`);
    if (matches.some(item => sameRecord(item, record))) continue;
    if (record.name === `_dmarc.${domain}` && matches.some(item => item.type === 'TXT' && /^v=DMARC1;/i.test(item.content))) continue;
    if (matches.some(item => item.type === record.type) && !(record.type === 'MX' &&
        matches.filter(item => item.type === 'MX').every(item => /^route[123]\.mx\.cloudflare\.net\.?$/i.test(item.content)))) {
      throw new Error(`Existing DNS conflict at ${record.name}; nothing overwritten.`);
    }
    await cf.request('POST', `/zones/${zoneId}/dns_records`, record);
    existing.push(record);
  }
}

export async function inspect(cf, { accountId, domain, repository, ownerEmail }) {
  if (!hex32.test(accountId)) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID.');
  const zoneList = await cf.list('/zones', { name: domain, 'account.id': accountId });
  const zone = zoneList.find(item => item.name === domain && item.account?.id === accountId);
  if (!zone || zone.status !== 'active' || !hex32.test(zone.id)) throw new Error('Domain must be an active, exact Cloudflare zone in this account.');
  const account = `/accounts/${accountId}`;
  const zonePath = `/zones/${zone.id}`;
  const named = names(domain);
  const namespaces = await cf.list(`${account}/storage/kv/namespaces`);
  const matches = namespaces.filter(item => item.title === named.kv);
  if (matches.length > 1) throw new Error('Duplicate deployment namespaces; manual review required.');
  let state = matches.length ? await cf.value(accountId, matches[0].id, STATE_KEY) : null;
  if (matches.length && !state) throw new Error('Existing KV namespace is not owned by this deployment tool.');
  if (state) {
    assertState(state, accountId, zone.id, domain, repository);
    if (state.kvId !== matches[0].id) throw new Error('KV binding mismatch.');
  }
  const settings = await cf.get(`${account}/workers/scripts/${named.worker}/settings`, true);
  if (settings && (!state || !settings.bindings?.some(item => item.name === 'ONECLICK_DEPLOYMENT_ID' && item.text === state.deploymentId))) {
    throw new Error('Worker already exists and is not owned by this deployment.');
  }
  if (settings && state.databaseId && !settings.bindings.some(item => item.name === 'db' && item.id === state.databaseId)) {
    throw new Error('Worker D1 binding changed; refusing to overwrite it.');
  }
  if (settings && !settings.bindings.some(item => item.name === 'kv' && item.namespace_id === state.kvId)) {
    throw new Error('Worker KV binding changed; refusing to overwrite it.');
  }
  const domains = await cf.list(`${account}/workers/domains`);
  const bound = domains.filter(item => item.hostname === named.hostname);
  if (bound.some(item => !state || item.service !== named.worker)) throw new Error('Website hostname is already bound to another Worker.');
  const routes = await cf.list(`${zonePath}/workers/routes`);
  for (const route of routes) {
    const pattern = route.pattern.replace(/^https?:\/\//, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    if (new RegExp(`^${pattern}$`).test(`${named.hostname}/`) && route.script !== named.worker) {
      throw new Error('An existing Worker route covers the website hostname.');
    }
  }
  const records = await cf.list(`${zonePath}/dns_records`);
  if (!bound.length && records.some(item => item.name === named.hostname)) throw new Error('Website DNS record already exists; nothing overwritten.');
  for (const record of records.filter(item => item.name === domain && item.type === 'MX')) {
    if (!/^route[123]\.mx\.cloudflare\.net\.?$/i.test(record.content)) throw new Error('Existing non-Cloudflare MX records; refusing to change the mail provider.');
  }
  for (const record of records.filter(item => item.name === domain && item.type === 'TXT' && /^v=spf1\b/i.test(item.content))) {
    if (record.content !== 'v=spf1 include:_spf.mx.cloudflare.net ~all') throw new Error('Existing SPF requires manual review; nothing overwritten.');
  }
  const catchAll = await cf.get(`${zonePath}/email/routing/rules/catch_all`, true);
  if (catchAll?.enabled && (!state || catchAll.actions?.length !== 1 || catchAll.actions[0].type !== 'worker' ||
      catchAll.actions[0].value?.[0] !== named.worker)) throw new Error('Existing active Catch-all belongs to another service.');
  const rules = await cf.list(`${zonePath}/email/routing/rules`);
  if (rules.some(item => item.enabled && !item.matchers?.every(matcher => matcher.type === 'all'))) {
    throw new Error('Existing address-specific routing rules need manual review.');
  }
  const destinations = await cf.list(`${account}/email/routing/addresses`);
  if (!destinations.some(item => item.email?.toLowerCase() === ownerEmail.toLowerCase() && item.verified)) {
    throw new Error('MAIL_OWNER_EMAIL must first be verified as a Cloudflare destination address.');
  }
  const senders = await cf.list(`${zonePath}/email/sending/subdomains`);
  if (state?.sendingRequested && !state.sendingId && senders.length === 1 && senders[0].name === domain && hex32.test(senders[0].tag)) {
    state.sendingId = senders[0].tag;
  }
  if (senders.some(item => !state?.sendingId || item.tag !== state.sendingId)) {
    throw new Error('Email Sending already has a domain configuration; manual review required.');
  }
  return { zone, state, named, settings, bound, senders };
}

export function workerConfig(state, workerDir) {
  return {
    name: state.worker, main: join(workerDir, 'src/oneclick-entry.js'),
    compatibility_date: '2025-06-04', keep_vars: true, workers_dev: false,
    observability: { enabled: true },
    vars: { admin: `admin@${state.domain}`, domain: [state.domain], project_link: false,
      ONECLICK_DOMAIN: state.domain, ONECLICK_DEPLOYMENT_ID: state.deploymentId },
    d1_databases: [{ binding: 'db', database_name: state.databaseName, database_id: state.databaseId }],
    kv_namespaces: [{ binding: 'kv', id: state.kvId }], send_email: [{ name: 'email' }], ai: { binding: 'ai' },
    assets: { binding: 'assets', directory: join(workerDir, 'dist'), not_found_handling: 'single-page-application', run_worker_first: true },
    triggers: { crons: ['0 16 * * *'] }
  };
}

export async function initialize(cf, state, schema, ownerEmail, forward) {
  const query = (sql, params) => cf.query(state.accountId, state.databaseId, sql, params);
  const tables = (await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))[0].results;
  const metaExists = tables.some(item => item.name === '_cloudmail_deployment');
  if (!metaExists && tables.length) throw new Error('Database is not empty and has no deployment ownership marker.');
  if (!metaExists) {
    await query('CREATE TABLE _cloudmail_deployment (id INTEGER PRIMARY KEY CHECK(id=1), deployment_id TEXT NOT NULL, domain TEXT NOT NULL, schema_ready INTEGER NOT NULL DEFAULT 0, activated INTEGER NOT NULL DEFAULT 0, activation_hash TEXT, activation_expires INTEGER);');
    await query('INSERT INTO _cloudmail_deployment (id,deployment_id,domain) VALUES (1,?,?)', [state.deploymentId, state.domain]);
  }
  const meta = (await query('SELECT * FROM _cloudmail_deployment WHERE id=1'))[0].results[0];
  if (meta?.deployment_id !== state.deploymentId || meta.domain !== state.domain) throw new Error('D1 ownership mismatch.');
  if (meta.schema_ready) return meta;
  const userExists = tables.some(item => item.name === 'user');
  if (userExists) {
    const users = (await query('SELECT email FROM user'))[0].results;
    const hasMail = tables.some(item => item.name === 'email') && (await query('SELECT COUNT(*) AS count FROM email'))[0].results[0].count;
    if (users.some(item => item.email !== `admin@${state.domain}`) || users.length > 1 || hasMail) {
      throw new Error('Incomplete initialization contains user data; refusing to reinitialize.');
    }
  }
  await query(schema);
  // Reserve admin before exposing the website. An activation code is required to set its password.
  await query('INSERT INTO user (email,password,salt,type) SELECT ?,?,?,1 WHERE NOT EXISTS (SELECT 1 FROM user)', [`admin@${state.domain}`, random(), random()]);
  await query("INSERT INTO account (email,user_id,name) SELECT email,user_id,'admin' FROM user WHERE email=? AND NOT EXISTS (SELECT 1 FROM account WHERE email=?)", [`admin@${state.domain}`, `admin@${state.domain}`]);
  await query('UPDATE setting SET register=1, notice=1, title=?, forward_email=?, forward_status=?, rule_type=1, rule_email=?',
    [state.domain, forward ? ownerEmail : '', forward ? 0 : 1, `admin@${state.domain}`]);
  await query('UPDATE _cloudmail_deployment SET schema_ready=1 WHERE id=1');
  return { ...meta, schema_ready: 1 };
}

async function requestActivation(cf, state, ownerEmail) {
  const code = random();
  console.log(`::add-mask::${code}`);
  await cf.query(state.accountId, state.databaseId,
    'UPDATE _cloudmail_deployment SET activation_hash=?,activation_expires=? WHERE id=1 AND activated=0', [hash(code), Date.now() + 86400000]);
  const { result } = await cf.request('POST', `/accounts/${state.accountId}/email/sending/send`, {
    from: `admin@${state.domain}`, to: [ownerEmail], subject: `Cloud Mail activation: ${state.domain}`,
    text: `Website: https://mail.${state.domain}/setup\nAdmin: admin@${state.domain}\nActivation code (expires in 24 hours):\n${code}\n\nSet your own password on the setup page. Do not share this code. Re-running this workflow invalidates older pending codes.`
  });
  const includesOwner = values => Array.isArray(values) && values.some(value => value.toLowerCase() === ownerEmail.toLowerCase());
  if (includesOwner(result?.permanent_bounces) || includesOwner(result?.suppressed_recipients) ||
      !(includesOwner(result?.queued) || includesOwner(result?.delivered))) {
    throw new Error('Activation email was not queued or delivered to the owner. Check Cloudflare sending logs and rerun this same workflow.');
  }
}

function report(state, status, publicDNS = 'not_rechecked_existing_project') {
  return { domain: state.domain, hostname: `mail.${state.domain}`, worker: state.worker, databaseId: state.databaseId,
    activated: !!status.activated, forward: !!state.forward, publicDNS, receiveTest: 'pending_external_test',
    sendTest: status.activated ? 'not_requested_already_active' : 'activation_email_requested' };
}

export async function provision({ cf, accountId, domain, repository, commit, ownerEmail, forward = false, apply = false,
  workerDir, schema, deployWorker, probe = probeWebsite, verifyDNS = verifyPublicDNS, log = console.log }) {
  domain = domainName(domain);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail || '')) throw new Error('Set MAIL_OWNER_EMAIL in GitHub Secrets.');
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('A fixed source commit and repository are required.');
  const checked = await inspect(cf, { accountId, domain, repository, ownerEmail });
  let state = checked.state;
  log(`Preflight passed for ${domain}. ${apply ? 'Creating/resuming only this project.' : 'Read-only plan; no changes made.'}`);
  if (!apply) return { domain, hostname: checked.named.hostname, mode: 'plan', existing: !!state };
  const account = `/accounts/${accountId}`;
  const zonePath = `/zones/${checked.zone.id}`;
  if (state && state.commit !== commit) throw new Error('Resume using the original workflow run/commit. This command never upgrades existing projects.');
  const save = () => cf.putValue(accountId, state.kvId, STATE_KEY, state);
  if (!state) {
    const created = (await cf.request('POST', `${account}/storage/kv/namespaces`, { title: checked.named.kv })).result;
    if (!hex32.test(created?.id)) throw new Error('Invalid KV creation response.');
    const deploymentId = random();
    state = { version: APP_VERSION, repository, commit, accountId, zoneId: checked.zone.id, domain,
      worker: checked.named.worker, kvId: created.id, deploymentId, forward,
      databaseName: `cm-db-${hash(domain).slice(0, 20)}-${deploymentId.slice(0, 8)}` };
    await save();
  }
  const databases = await cf.list(`${account}/d1/database`);
  let database = databases.find(item => item.name === state.databaseName);
  if (state.databaseId && database?.uuid !== state.databaseId) throw new Error('Recorded database disappeared or changed; no replacement created.');
  if (!database) database = (await cf.request('POST', `${account}/d1/database`, { name: state.databaseName })).result;
  if (!uuid.test(database?.uuid)) throw new Error('Invalid D1 creation response.');
  state.databaseId = database.uuid;
  await save();
  await initialize(cf, state, schema, ownerEmail, forward);
  if (state.configured) {
    const status = await probe(`https://${checked.named.hostname}/_cloudmail/health`, state.deploymentId);
    if (!status.activated) await requestActivation(cf, state, ownerEmail);
    log('Existing project retained. No Worker, password, routing, DNS, or JWT update performed.');
    return report(state, status);
  }
  const config = workerConfig(state, workerDir);
  if (!state.workerDeployed) {
    await deployWorker(config);
    state.workerDeployed = true;
    await save();
  }
  const secrets = await cf.get(`${account}/workers/scripts/${state.worker}/secrets`);
  if (!Array.isArray(secrets)) throw new Error('Unexpected Worker secrets response.');
  if (!secrets.some(item => item.name === 'jwt_secret')) {
    await cf.request('PUT', `${account}/workers/scripts/${state.worker}/secrets`, { name: 'jwt_secret', text: random(), type: 'secret_text' });
  }
  const bound = await cf.list(`${account}/workers/domains`);
  const currentDomain = bound.find(item => item.hostname === checked.named.hostname);
  if (currentDomain && currentDomain.service !== state.worker) throw new Error('Hostname changed ownership during deployment.');
  if (!currentDomain) {
    const dns = await cf.list(`${zonePath}/dns_records`, { name: checked.named.hostname });
    if (dns.length) throw new Error('Website DNS appeared during deployment; refusing to overwrite.');
    await cf.request('PUT', `${account}/workers/domains`, { hostname: checked.named.hostname, zone_id: state.zoneId, service: state.worker, environment: 'production' });
  }
  if (!state.sendingId) {
    // Persist intent before the provider mutation so a retry can reconcile an interrupted response.
    state.sendingRequested = true;
    await save();
    const sender = (await cf.request('POST', `${zonePath}/email/sending/subdomains`, { name: domain })).result;
    if (!hex32.test(sender?.tag)) throw new Error('Invalid Email Sending domain response.');
    state.sendingId = sender.tag;
    await save();
  }
  const sendingRecords = await cf.get(`${zonePath}/email/sending/subdomains/${state.sendingId}/dns`);
  await ensureEmailDNS(cf, state.zoneId, domain, sendingRecords, 'sending');
  const routing = await cf.get(`${zonePath}/email/routing`, true);
  if (!routing?.enabled) await cf.request('POST', `${zonePath}/email/routing/dns`, { name: domain });
  const routingRecords = await cf.get(`${zonePath}/email/routing/dns`);
  await ensureEmailDNS(cf, state.zoneId, domain, routingRecords, 'routing');
  const catchAll = await cf.get(`${zonePath}/email/routing/rules/catch_all`, true);
  if (catchAll?.enabled && !(catchAll.actions?.length === 1 && catchAll.actions[0].type === 'worker' && catchAll.actions[0].value?.[0] === state.worker)) {
    throw new Error('Catch-all changed ownership during deployment; nothing overwritten.');
  }
  if (!catchAll?.enabled) await cf.request('PUT', `${zonePath}/email/routing/rules/catch_all`, {
    enabled: true, name: `Cloud Mail ${domain}`, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [state.worker] }]
  });
  const publicRecords = [...routingRecords, ...sendingRecords].map(record => normalizeRecord(record, domain));
  const dmarc = (await cf.list(`${zonePath}/dns_records`, { name: `_dmarc.${domain}`, type: 'TXT' }))
    .filter(record => record.name === `_dmarc.${domain}` && record.type === 'TXT' && /^v=DMARC1;/i.test(record.content));
  if (dmarc.length !== 1) throw new Error('Exactly one DMARC policy is required; existing records were not changed.');
  const expectedDNS = publicRecords.filter(record => record.name !== `_dmarc.${domain}`);
  expectedDNS.push(normalizeRecord(dmarc[0], domain));
  await verifyDNS(expectedDNS);
  const status = await probe(`https://${checked.named.hostname}/_cloudmail/health`, state.deploymentId);
  if (!status.activated) {
    await requestActivation(cf, state, ownerEmail);
    log('Activation email accepted by Cloudflare. Check the configured owner mailbox, including spam. Delivery is not yet confirmed.');
  }
  state.configured = true;
  await save();
  return report(state, status, 'verified_on_two_public_resolvers');
}

export async function probeWebsite(url, deploymentId, fetcher = fetch) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const data = await response.json();
        if (data.deploymentId === deploymentId && data.schemaReady) return data;
      }
    } catch { /* Custom-domain certificate/DNS may still be provisioning. */ }
    if (attempt < 29) await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error('Website DNS/TLS/health is not ready yet. Re-run this same workflow to resume.');
}

async function cli() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some(arg => !['--apply', '--plan'].includes(arg)) || (apply && process.argv.includes('--plan'))) throw new Error('Use --plan or --apply.');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const workerDir = join(root, 'mail-worker');
  const configPath = join(workerDir, 'wrangler.oneclick.generated.json');
  const cf = new Cloudflare(process.env.CLOUDFLARE_API_TOKEN);
  const execute = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw new Error('Build/deployment failed. No old project was modified.');
  };
  try {
    const result = await provision({ cf, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, domain: process.env.MAIL_DOMAIN,
      repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, ownerEmail: process.env.MAIL_OWNER_EMAIL,
      forward: process.env.MAIL_FORWARD_TO_OWNER === 'true', apply, workerDir,
      schema: apply ? await freshSchema(new URL('../mail-worker/', import.meta.url)) : '',
      deployWorker: async config => {
        await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
        execute(process.execPath, [join(workerDir, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', configPath], workerDir);
      }
    });
    const summary = `## Cloud Mail deployment\n\nWebsite: https://${result.hostname}\n\nAdmin: admin@${result.domain}\n\nMode: ${apply ? 'apply' : 'read-only plan'}\n\n${apply ? 'Check the owner mailbox for activation. Inbound end-to-end testing remains pending. CF native sending may still display on-behalf-of in QQ.' : 'No resources or DNS records were changed.'}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(JSON.stringify(result));
  } finally {
    await rm(configPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
