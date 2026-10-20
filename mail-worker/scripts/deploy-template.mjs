import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const templateBranch = 'qq-sender-template';
const defaultWorkerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function required(env, key, pattern) {
  const value = env[key]?.trim();
  if (!value || !pattern.test(value)) {
    throw new Error(`Missing or invalid ${key}. See DEPLOY-TEMPLATE.md.`);
  }
  return value;
}

export function createConfig(env) {
  if (env.WORKERS_CI === '1' && env.WORKERS_CI_BRANCH !== templateBranch) {
    throw new Error(`Only the production branch ${templateBranch} may use this template.`);
  }

  const name = required(env, 'MAIL_WORKER_NAME', /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  const databaseName = required(env, 'MAIL_D1_DATABASE_NAME', /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);
  const databaseId = required(env, 'MAIL_D1_DATABASE_ID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const kvId = required(env, 'MAIL_KV_NAMESPACE_ID', /^[0-9a-f]{32}$/i);

  return {
    name,
    main: 'src/index.js',
    compatibility_date: '2025-06-04',
    keep_vars: true,
    observability: { enabled: true },
    d1_databases: [{ binding: 'db', database_name: databaseName, database_id: databaseId }],
    kv_namespaces: [{ binding: 'kv', id: kvId }],
    ai: { binding: 'ai' },
    assets: {
      binding: 'assets',
      directory: './dist',
      not_found_handling: 'single-page-application',
      run_worker_first: true
    },
    triggers: { crons: ['0 16 * * *'] }
  };
}

export function deploy(args, env, { workerDir = defaultWorkerDir, execute = spawnSync } = {}) {
  if (args.length > 1 || args.some(arg => !['--check', '--dry-run'].includes(arg))) {
    throw new Error('Use npm run deploy, npm run check:template, or npm run deploy -- --dry-run.');
  }
  const config = createConfig(env);
  if (args[0] === '--check') {
    console.log(`Template configuration valid for Worker ${config.name}. No deployment performed.`);
    return;
  }

  const configPath = join(workerDir, 'wrangler.generated.json');
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const run = (command, commandArgs, shell = false) => {
    const result = execute(command, commandArgs, { cwd: workerDir, env, stdio: 'inherit', shell });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Build/deploy command failed (${result.status ?? result.signal}).`);
  };

  // Always render from this project's variables, never from an old generated file.
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    run(pnpm, ['--prefix', '../mail-vue', 'install', '--frozen-lockfile'], process.platform === 'win32');
    run(pnpm, ['--prefix', '../mail-vue', 'run', 'build'], process.platform === 'win32');
    const commandArgs = [
      join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'deploy', '--config', configPath
    ];
    if (args[0] === '--dry-run') {
      commandArgs.push('--dry-run', '--outdir', join(workerDir, '.wrangler', 'template-dry-run'));
    }
    run(process.execPath, commandArgs);
  } finally {
    rmSync(configPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    deploy(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
