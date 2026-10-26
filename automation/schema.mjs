import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

export function sqliteAdapter(database) {
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    async run() { return { success: true, meta: database.prepare(sql).run(...params) }; },
    async first() { return database.prepare(sql).get(...params) || null; },
    async all() { return { results: database.prepare(sql).all(...params) }; }
  });
  return {
    prepare,
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

export function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('Unsupported schema seed value.');
}

const identifier = name => `"${name.replaceAll('"', '""')}"`;

// Run the repository's real migrations in a fresh, local SQLite database.
// The three collaborators are explicitly linked; no source rewriting or remote code is used.
export async function freshSchema(workerDir) {
  const source = await readFile(new URL('src/init/init.js', workerDir), 'utf8');
  const database = new DatabaseSync(':memory:');
  const module = new SourceTextModule(source);
  const collaborators = {
    '../service/setting-service': ['default', { refresh: async () => {} }],
    '../utils/email-utils': ['default', { getName: address => address.split('@')[0] }],
    '../const/entity-const': ['emailConst', { type: { RECEIVE: 0 } }]
  };
  try {
    await module.link(specifier => {
      const entry = collaborators[specifier];
      if (!entry) throw new Error(`Review new initializer dependency: ${specifier}`);
      return new SyntheticModule([entry[0]], function () { this.setExport(entry[0], entry[1]); });
    });
    await module.evaluate();
    await module.namespace.dbInit.init({
      req: { param: () => 'local-schema-generation' },
      env: { jwt_secret: 'local-schema-generation', db: sqliteAdapter(database) },
      text: value => value
    });
    for (const [table, column] of [['setting', 'forward_email'], ['setting', 'ai_code'], ['email', 'unread'], ['account', 'name']]) {
      if (!database.prepare(`PRAGMA table_info(${identifier(table)})`).all().some(item => item.name === column)) {
        throw new Error(`Fresh schema is missing ${table}.${column}.`);
      }
    }
    const tables = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const output = [];
    for (const table of tables) {
      output.push(table.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ') + ';');
      const columns = database.prepare(`PRAGMA table_info(${identifier(table.name)})`).all().map(item => item.name);
      for (const row of database.prepare(`SELECT * FROM ${identifier(table.name)}`).all()) {
        const values = columns.map(column => literal(row[column])).join(',');
        if (table.name === 'setting') {
          output.push(`INSERT INTO setting (${columns.map(identifier)}) SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM setting);`);
        } else output.push(`INSERT OR IGNORE INTO ${identifier(table.name)} (${columns.map(identifier)}) VALUES (${values});`);
      }
    }
    for (const index of database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()) {
      output.push(index.sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, (_, unique = '') => `CREATE ${unique}INDEX IF NOT EXISTS `) + ';');
    }
    return output.join('\n');
  } finally {
    database.close();
  }
}
