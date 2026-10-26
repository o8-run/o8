import { CODEX_MODEL_IDS } from '@/lib/models';
import { MANUAL_THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';

const models = [...CODEX_MODEL_IDS, 'gpt-future-fixture'];
/** Explicit permissive discovery for tests concerned with transport mapping. */
export const codexEffortCatalogFixture = {
  models: Object.fromEntries(models.map(model => [model, []])),
  defaultModel: 'gpt-6.1-sol',
  reasoningEfforts: Object.fromEntries(models.map(model => [model, [...MANUAL_THINKING_EFFORTS]])),
};

/** Add read-only model discovery to a finite executable fixture. */
export function codexModelListFixtureScript(): string {
  const data = models.map(model => ({ model,
    supportedReasoningEfforts: MANUAL_THINKING_EFFORTS.map(reasoningEffort => ({ reasoningEffort })),
  }));
  return `if(args[0]==='app-server'){
 import('node:readline').then(({createInterface})=>createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.id)return;
  const result=m.method==='model/list'?{data:${JSON.stringify(data)}}:m.method==='config/read'?{config:{model:'gpt-6.1-sol'}}:{};
  console.log(JSON.stringify({id:m.id,result}));
 }).on('close',()=>process.exit(0)));
}else{`;
}
