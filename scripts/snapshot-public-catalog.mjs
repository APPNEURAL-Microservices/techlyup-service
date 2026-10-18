import { readFile, writeFile } from 'node:fs/promises';
// Input is an explicitly exported public website catalogue, never database rows.
const input = process.argv[2];
if (!input) throw new Error('Provide a public website catalogue JSON export.');
const data = JSON.parse(await readFile(input, 'utf8'));
const base = 'https://techlyup.com';
const items = [
 ...data.courses.filter(c=>c.status==='published').map(c=>({id:c.id,kind:'course',title:c.title,description:c.outcome,category:'AI & practical skills',level:c.level,status:'available',duration:`${c.practiceEffortMinutes} min practice`,priceLabel:c.accessType==='free'?'Free':'See current price',websiteUrl:`${base}/courses/${c.slug}`})),
 ...data.webinars.filter(w=>w.published!==false).map(w=>({id:w.id,kind:'webinar',title:w.title,description:w.description,category:w.bestFor||'Live learning',level:'All levels',status:'scheduled',duration:w.duration,startsAt:w.datetime,priceLabel:w.pricing?.type==='free'?'Free':'See current price',websiteUrl:`${base}/webinars/${w.id}`,imageUrl:w.image?base+w.image:undefined})),
 ...data.mentors.map(m=>({id:m.id,kind:'mentorship',title:m.name,description:m.expertise.join(' · '),category:m.category,level:'All levels',status:'request',priceLabel:'Fee confirmed after review',websiteUrl:`${base}/mentorship/${m.id}`})),
 {id:'career-finder',kind:'career',title:'Find your career direction',description:'Explore role choices and identify a practical next step.',category:'Career development',level:'All levels',status:'available',priceLabel:'Free tool',websiteUrl:`${base}/career-finder`},
 {id:'career-resources',kind:'career',title:'Build your application toolkit',description:'Explore the published resources and career preparation tools.',category:'Career development',level:'All levels',status:'available',priceLabel:'See published resources',websiteUrl:`${base}/resources`},
];
await writeFile('packages/contracts/src/catalog.ts', `// Public source snapshot: techlyup-next src/data/{courses,workshops,mentors}. No availability/capacity guarantee.\nimport type { Catalog } from './index';\nexport const publicCatalog: Catalog = ${JSON.stringify({items,source:'website-snapshot',updatedAt:new Date().toISOString()},null,2)};\n`);
await writeFile('packages/contracts/src/taxonomy.ts', `// Exact canonical public profile choices from techlyup-next/src/data/learning-taxonomy.ts.\nexport const profileTaxonomy = ${JSON.stringify(data.taxonomy,null,2)} as const;\n`);
