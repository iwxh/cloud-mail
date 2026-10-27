import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerConfig, names } from './provision.mjs';

const workerDir = fileURLToPath(new URL('../mail-worker/', import.meta.url));
const path = join(workerDir, 'wrangler.oneclick.generated.json');
const state = {
  ...names('example.com'), domain: 'example.com', deploymentId: 'a'.repeat(64), databaseName: 'ci-only',
  databaseId: '11111111-1111-4111-8111-111111111111', kvId: '1'.repeat(32)
};
try {
  await writeFile(path, JSON.stringify(workerConfig(state, workerDir)), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(workerDir, 'node_modules/wrangler/bin/wrangler.js'),
    'deploy', '--config', path, '--dry-run', '--outdir', '.wrangler/oneclick-check'], {
    cwd: workerDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error('One-click Worker bundle check failed.');
} finally {
  await rm(path, { force: true });
}
