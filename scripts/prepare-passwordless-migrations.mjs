import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Preparation only, like prepare-account-live-migrations.mjs: no network or child process, and it cannot apply SQL.
// Writes a migrations-only wrangler config holding exactly 0055 + 0056, so an operator can apply them to the
// canonical D1 without touching the unreviewed 0048-0053 in migrations/d1.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/prepare-passwordless-migrations.mjs --output <new-directory>');
const output = resolve(args[1]);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(root + 'apps/api/wrangler.jsonc', 'utf8');
const config = JSON.parse(source.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n'));
const production = config.env?.production;
const db = production?.d1_databases?.[0];
if (production?.name !== 'techlyup-app-api' || production?.d1_databases?.length !== 1 || db?.binding !== 'REGISTRATIONS_DB' || db?.database_name !== 'techlyup-registrations' || db?.database_id !== 'e98173f2-34c9-4b47-b36c-755d2bf775dd') throw new Error('Canonical production target changed; review the release again.');
const vars = production.vars;
if (vars.APP_ENABLED !== 'true' || vars.APP_SIGNUP_ENABLED !== 'true' || vars.APP_LIVE_LOGIN_ENABLED !== 'true' || vars.APP_ENV !== 'production' || vars.APP_ALLOWED_ORIGINS !== 'https://app.techlyup.com' || vars.EMAIL_FROM !== 'admin@notify.techlyup.com') throw new Error('Passwordless production scope changed; review the release again.');
if (!production.send_email?.some(binding => binding.name === 'EMAIL')) throw new Error('Email codes need the EMAIL send_email binding.');
const optional = ['APP_SUPPORT_CREDITS_ENABLED', 'APP_SUPPORT_TEST_PAYMENTS_ENABLED', 'APP_ANALYTICS_ENABLED', 'APP_LEARNING_ENABLED', 'APP_PLATFORM_ENABLED', 'APP_CRM_ENABLED', 'APP_CRM_CAPTURE_ENABLED', 'APP_CRM_WEBINAR_ENABLED', 'APP_CRM_SENDING_ENABLED', 'APP_CRM_INTEGRATIONS_ENABLED', 'CRM_ANALYTICS_EXPORT_ENABLED'];
for (const key of optional) if (vars[key] !== 'false') throw new Error('Optional production capabilities must remain disabled.');
const names = ['0055_passwordless_registration.sql', '0056_live_passcodes.sql'];
const files = names.map(name => ({ name, sql: readFileSync(root + 'migrations/d1/' + name, 'utf8') }));
mkdirSync(output); // Refuse to overwrite any existing release directory.
mkdirSync(output + '/migrations');
for (const { name, sql } of files) writeFileSync(output + '/migrations/' + name, sql, { flag: 'wx' });
writeFileSync(output + '/wrangler.jsonc', JSON.stringify({
  name: 'techlyup-passwordless-migration-review', compatibility_date: config.compatibility_date,
  d1_databases: [{ binding: db.binding, database_name: db.database_name, database_id: db.database_id, migrations_dir: './migrations' }],
}, null, 2) + '\n', { flag: 'wx' });
const manifest = {
  date: '2026-10-21', scope: 'Prepared files only. No production action, migration, backup or deployment was performed.',
  canonicalDatabase: { name: db.database_name, id: db.database_id },
  migrations: files.map(({ name, sql }) => ({ name, sha256: createHash('sha256').update(sql).digest('hex') })),
  alreadyApplied: ['0047_native_app_foundation.sql', '0054_account_registration_live_login.sql'],
  excludedMigrations: 'Website0037-0046; optional app0048-0053; all PostgreSQL migrations.',
  additive: 'Both create new tables only; no existing table, column or row is changed.',
  optionalCapabilities: Object.fromEntries(optional.map(key => [key, false])),
};
writeFileSync(output + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ prepared: output, migrations: names, noRemoteOperation: true }) + '\n');
