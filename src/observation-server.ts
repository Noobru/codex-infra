import {createServer,type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ObservationReader} from './observability.js';
import {DashboardReader, DashboardViewSchema} from './dashboard.js';
import {InteractionStatusSchema} from './interactions.js';

/** Local human view: one read-only reader, no dispatch endpoints or second source of truth. */
export class ObservationServer {
  private readonly reader:ObservationReader;
  private server:Server|undefined;
  private readonly dashboard:DashboardReader;
  constructor(readonly root:string){this.dashboard=new DashboardReader(root);this.reader=this.dashboard.reader;}
  async start(port=4317):Promise<{url:string}> {
    if(this.server)throw new Error('Observation server already started');
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid observation port');
    const assets:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/app.css':['app.css','text/css; charset=utf-8']};
    this.server=createServer(async(req,res)=>{
      const address=this.server!.address();const boundPort=address&&typeof address==='object'?address.port:port;
      if(![`127.0.0.1:${boundPort}`,`localhost:${boundPort}`].includes(req.headers.host??'')){res.writeHead(403).end();return;}
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'}).end();return;}
      try {
        const url=new URL(req.url??'/',`http://127.0.0.1:${boundPort}`);
        const n=(name:string):number|undefined=>url.searchParams.has(name)?Number(url.searchParams.get(name)):undefined;
        let data:unknown;
        if(url.pathname==='/api/view')data=await this.dashboard.screen({
          view:DashboardViewSchema.parse(url.searchParams.get('view')??'overview'),
          projectId:url.searchParams.get('project_id')||undefined,jobId:url.searchParams.get('job_id')||undefined,
          status:url.searchParams.get('status')||undefined,query:url.searchParams.get('query')||undefined,
          sort:url.searchParams.get('sort')==='oldest'?'oldest':'newest',limit:n('limit'),offset:n('offset'),afterEventId:n('after_event_id'),evaluationOffset:n('evaluation_offset'),
          interactionOffset:n('interaction_offset'),interactionLimit:n('interaction_limit'),
          interactionStatus:url.searchParams.has('interaction_status')?InteractionStatusSchema.parse(url.searchParams.get('interaction_status')):undefined,
          ...(url.searchParams.has('baseline_id')?{comparison:{baselineId:url.searchParams.get('baseline_id')!,treatmentId:url.searchParams.get('treatment_id')??'',metricId:url.searchParams.get('metric_id')??''}}:{}),
        });
        else if(url.pathname==='/api/overview')data=await this.reader.overview({projectId:url.searchParams.get('project_id')??undefined,limit:n('limit'),offset:n('offset')});
        else if(/^\/api\/runs\/[a-zA-Z0-9-]+$/.test(url.pathname))data=await this.reader.run(url.pathname.split('/').at(-1)!,{afterEventId:n('after_event_id'),limit:n('limit')});
        else if(url.pathname==='/api/health')data={status:'ready',storage:'read-only',authority:'observe-only'};
        else if(assets[url.pathname]){
          const [file,mime]=assets[url.pathname]!;
          const content=await readFile(path.join(this.root,'ui/dist',file));
          res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'}).end(content);return;
        } else {res.writeHead(404,{'Content-Type':'application/json'}).end(JSON.stringify({error:'not_found'}));return;}
        const body=JSON.stringify(data);
        const etag='"'+createHash('sha256').update(JSON.stringify(data,(key,value)=>key==='observedAt'?undefined:value)).digest('hex')+'"';
        res.setHeader('ETag',etag);res.setHeader('Cache-Control','private, no-cache');
        res.setHeader('X-Observed-At',(data as {observedAt?:string}).observedAt??new Date().toISOString());
        if(req.headers['if-none-match']===etag){res.writeHead(304).end();return;}
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(body);
      }catch(error){
        const message=error instanceof Error?error.message:'';
        const busy=/locked|busy/i.test(message);
        const notFound=/^Job not found:/i.test(message);
        const invalid=/must|invalid|expected|limit|offset/i.test(message);
        res.writeHead(busy?503:notFound?404:invalid?400:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:busy?'database_busy':notFound?'not_found':invalid?'invalid_request':'unavailable'}));
      }
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(port,'127.0.0.1',resolve);});
    const address=this.server.address();
    return {url:`http://127.0.0.1:${typeof address==='object'&&address?address.port:port}`};
  }
  async close():Promise<void>{
    if(this.server){const server=this.server;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));this.server=undefined;}
    this.dashboard.close();
  }
}
