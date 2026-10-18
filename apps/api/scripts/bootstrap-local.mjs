import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// No user-controlled CLI forwarding, remote flag, binding or account selection.
if(process.argv.length!==2)throw new Error('Local bootstrap accepts no arguments.');
const cwd=fileURLToPath(new URL('../',import.meta.url));
for(const args of [
 ['wrangler','d1','execute','REGISTRATIONS_DB','--local','--file','tests/fixtures/canonical.sql'],
 ['wrangler','d1','execute','REGISTRATIONS_DB','--local','--file','tests/fixtures/canonical-crm.sql'],
 ['wrangler','d1','migrations','apply','REGISTRATIONS_DB','--local'],
]){
 const result=spawnSync('npx',args,{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 if(result.error)throw new Error('Local D1 bootstrap could not launch Wrangler.');
 if(result.status!==0)process.exit(result.status??1);
}
