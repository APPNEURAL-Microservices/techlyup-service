import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Preparation only, like prepare-passwordless-migrations.mjs: no network or child process, and it cannot apply SQL.
// Writes a migrations-only wrangler config holding exactly 0057, so an operator can apply it to the canonical D1
// without touching the unreviewed 0048-0053 in migrations/d1. Studio drafts use their own D1 (migrations/studio).
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/prepare-products-migrations.mjs --output <new-directory>');
const output = resolve(args[1]);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(root + 'apps/api/wrangler.jsonc', 'utf8');
const config = JSON.parse(source.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n'));
const production = config.env?.production;
const db = production?.d1_databases?.find(binding => binding.binding === 'REGISTRATIONS_DB');
if (production?.name !== 'techlyup-app-api' || db?.database_name !== 'techlyup-registrations' || db?.database_id !== 'e98173f2-34c9-4b47-b36c-755d2bf775dd') throw new Error('Canonical production target changed; review the release again.');
const vars = production.vars;
if (vars.APP_ENV !== 'production' || vars.APP_ALLOWED_ORIGINS !== 'https://app.techlyup.com') throw new Error('Production app scope changed; review the release again.');
if (vars.APP_PRODUCTS_ENABLED !== 'false') throw new Error('Apply 0057 while product apps are still disabled.');
const names = ['0057_products_login.sql'];
const files = names.map(name => ({ name, sql: readFileSync(root + 'migrations/d1/' + name, 'utf8') }));
mkdirSync(output); // Refuse to overwrite any existing release directory.
mkdirSync(output + '/migrations');
for (const { name, sql } of files) writeFileSync(output + '/migrations/' + name, sql, { flag: 'wx' });
writeFileSync(output + '/wrangler.jsonc', JSON.stringify({
  name: 'techlyup-products-migration-review', compatibility_date: config.compatibility_date,
  d1_databases: [{ binding: db.binding, database_name: db.database_name, database_id: db.database_id, migrations_dir: './migrations' }],
}, null, 2) + '\n', { flag: 'wx' });
const manifest = {
  date: '2026-10-25', scope: 'Prepared files only. No production action, migration, backup or deployment was performed.',
  canonicalDatabase: { name: db.database_name, id: db.database_id },
  migrations: files.map(({ name, sql }) => ({ name, sha256: createHash('sha256').update(sql).digest('hex') })),
  alreadyApplied: ['0047_native_app_foundation.sql', '0054_account_registration_live_login.sql', '0055_passwordless_registration.sql', '0056_live_passcodes.sql'],
  excludedMigrations: 'Website0037-0046; optional app0048-0053; the separate Studio D1 migrations.',
  additive: 'Creates product login challenge and hashed session tables only; no existing table, column or row is changed.',
};
writeFileSync(output + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ prepared: output, migrations: names, noRemoteOperation: true }) + '\n');
