/** Explicit cross-owner acceptance, separate from this independent backend CI.
 * Missing reviewed siblings/dependencies is a failure, never a skipped pass. */
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {delimiter,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const required=['../notification-service/src/orchestration/delivery-source.ts','../notification-service/src/orchestration/service.ts','../messaging-service/src/transport/delivery-authority.ts','../messaging-service/src/transport/providers.ts','../cloudflare/node_modules/@js-temporal/polyfill/package.json','node_modules/tsx/dist/loader.mjs'];
try{await Promise.all(required.map(path=>access(join(root,path),constants.R_OK)));}
catch{console.error('Native bridge acceptance requires the reviewed notification-service, messaging-service and cloudflare sibling source/dependencies. Install their locked dependencies in the owning repositories; this check was not executed.');process.exit(1);}
const result=spawnSync(process.execPath,['--import','tsx','--test',join(root,'docs/release-audit-2026-10-16/native-consent-bridge.test.ts')],{cwd:root,stdio:'inherit',env:{...process.env,NODE_PATH:['node_modules','../notification-service/node_modules','../messaging-service/node_modules','../cloudflare/node_modules'].map(path=>join(root,path)).join(delimiter)}});
process.exit(result.status??1);
