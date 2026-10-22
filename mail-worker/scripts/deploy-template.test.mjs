import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig, deploy } from './deploy-template.mjs';

const example = {
  MAIL_WORKER_NAME: 'example-mail-one',
  MAIL_D1_DATABASE_NAME: 'example-mail-db-one',
  MAIL_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
  MAIL_KV_NAMESPACE_ID: '11111111111111111111111111111111'
};

test('separate projects render independent resource bindings', () => {
  const first = createConfig(example);
  const second = createConfig({
    MAIL_WORKER_NAME: 'example-mail-two',
    MAIL_D1_DATABASE_NAME: 'example-mail-db-two',
    MAIL_D1_DATABASE_ID: '22222222-2222-4222-8222-222222222222',
    MAIL_KV_NAMESPACE_ID: '22222222222222222222222222222222'
  });
  assert.notEqual(first.name, second.name);
  assert.notDeepEqual(first.d1_databases, second.d1_databases);
  assert.notDeepEqual(first.kv_namespaces, second.kv_namespaces);
  assert.equal(first.d1_databases[0].binding, 'db');
  assert.equal(first.kv_namespaces[0].binding, 'kv');
  assert.equal(first.keep_vars, true);
  assert.equal(first.assets.binding, 'assets');
  assert.equal(first.assets.directory, './dist');
  assert.equal(first.main, 'src/index.js');
});

for (const key of Object.keys(example)) {
  test(`missing ${key} fails without using a fallback`, () => {
    const env = { ...example };
    delete env[key];
    assert.throws(() => createConfig(env), new RegExp(key));
  });
  test(`invalid ${key} is rejected`, () => {
    assert.throws(() => createConfig({ ...example, [key]: 'invalid/value\n' }), new RegExp(key));
  });
}

test('runtime secrets and domain settings are not copied into generated configuration', () => {
  const config = createConfig({ ...example, JWT_SECRET: 'not-for-config', ADMIN: 'admin@example.com' });
  assert.equal(config.vars, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(JSON.stringify(config).includes('not-for-config'), false);
});

test('template and merged main are accepted; unrelated preview branches are blocked', () => {
  for (const branch of ['main', 'qq-sender-template']) {
    assert.doesNotThrow(() => createConfig({ ...example, WORKERS_CI: '1', WORKERS_CI_BRANCH: branch }));
  }
  for (const branch of ['other-preview', 'fix/qq-sender-kmail-20261020', undefined]) {
    assert.throws(() => createConfig({ ...example, WORKERS_CI: '1', WORKERS_CI_BRANCH: branch }), /production branches/);
  }
});

test('CLI cannot override target name or config, and validation runs before subprocesses', () => {
  const execute = () => assert.fail('No subprocess should run');
  for (const args of [['--name=existing-worker'], ['--config=old.json'], ['--check', '--dry-run']]) {
    assert.throws(() => deploy(args, example, { execute }), /Use npm run deploy/);
  }
  assert.throws(() => deploy([], {}, { execute }), /MAIL_WORKER_NAME/);
  deploy(['--check'], example, { execute });
});

for (const dryRun of [false, true]) {
  test(`deploy orchestration uses fresh bindings and removes generated config (dry-run=${dryRun})`, () => {
    const workerDir = mkdtempSync(join(tmpdir(), 'cloud-mail-template-'));
    const file = join(workerDir, 'wrangler.generated.json');
    const calls = [];
    writeFileSync(file, '{"name":"stale-wrong-project"}');
    try {
      deploy(dryRun ? ['--dry-run'] : [], example, {
        workerDir,
        execute(command, args) {
          calls.push({ command, args });
          assert.equal(JSON.parse(readFileSync(file, 'utf8')).name, example.MAIL_WORKER_NAME);
          return { status: 0 };
        }
      });
      assert.equal(calls.length, 3);
      assert.ok(calls[0].args.includes('--frozen-lockfile'));
      assert.equal(calls[2].command, process.execPath);
      assert.ok(calls[2].args.includes(file));
      assert.equal(calls[2].args.includes('--dry-run'), dryRun);
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(workerDir, { recursive: true, force: true });
    }
  });
}

test('failed frontend build prevents deployment and cleans generated config', () => {
  const workerDir = mkdtempSync(join(tmpdir(), 'cloud-mail-template-'));
  let calls = 0;
  try {
    assert.throws(() => deploy([], example, {
      workerDir,
      execute() { calls++; return { status: 1 }; }
    }), /command failed/);
    assert.equal(calls, 1);
    assert.equal(existsSync(join(workerDir, 'wrangler.generated.json')), false);
  } finally {
    rmSync(workerDir, { recursive: true, force: true });
  }
});

test('Sender is dynamic for admin and ordinary accounts, including replies and forwards', async () => {
  const source = readFileSync(new URL('../src/service/email-service.js', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('async sendByResend('), source.indexOf('async toCloudflareAttachments('));
  let captured;
  class Resend {
    constructor() { this.emails = { send: async form => { captured = form; return { data: { id: 'offline-test' } }; } }; }
  }
  const service = new Function('Resend', `return ({${method}})`)(Resend);
  service.toResendAttachments = async attachments => attachments;
  for (const accountEmail of ['admin@example.com', 'user@example.net']) {
    for (const sendType of ['normal', 'reply', 'forward']) {
      const attachments = [{ filename: 'example.txt', content: 'dGVzdA==' }];
      await service.sendByResend('unused-offline-token', {
        name: 'Test', accountEmail, sendType, receiveEmail: ['recipient@example.org'],
        subject: 'test', text: 'text', html: '<p>text</p>', messageId: '<test@example.com>', attachments
      });
      assert.equal(captured.headers.Sender, accountEmail);
      assert.equal(captured.from, `Test <${accountEmail}>`);
      assert.deepEqual(captured.attachments, attachments);
      if (sendType === 'reply') {
        assert.equal(captured.headers['in-reply-to'], '<test@example.com>');
        assert.equal(captured.headers.references, '<test@example.com>');
      }
    }
  }
});
