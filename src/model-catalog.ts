import type { AppServerClient } from './app-server.js';
import type { RuntimeModelCapability } from './routing.js';

/** Read capabilities from the actual host; model prices never represent subscription quota. */
export class ModelCatalog {
  async read(client:Pick<AppServerClient,'request'>):Promise<RuntimeModelCapability[]> {
    const models=new Map<string,RuntimeModelCapability>();
    let cursor:string|undefined;
    const seen=new Set<string>();
    do {
      const page=await client.request<{data:{id:string;model?:string;supportedReasoningEfforts:{reasoningEffort:string}[]}[];nextCursor?:string|null}>('model/list',{limit:100,includeHidden:true,...(cursor?{cursor}:{})});
      if(!Array.isArray(page.data))throw new Error('Runtime model catalog is unavailable');
      for(const model of page.data) {
        const id=model.model??model.id;
        if(typeof id!=='string'||!Array.isArray(model.supportedReasoningEfforts))continue;
        models.set(id,{id,supportedReasoningEfforts:model.supportedReasoningEfforts.map(e=>e.reasoningEffort).filter(e=>typeof e==='string')});
      }
      cursor=page.nextCursor??undefined;
      if(cursor) {if(seen.has(cursor)||seen.size>=10)throw new Error('Runtime model catalog pagination did not complete');seen.add(cursor);}
    } while(cursor);
    return [...models.values()];
  }
}
