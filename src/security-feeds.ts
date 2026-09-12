import crypto from 'node:crypto';
import { z } from 'zod';

const NonEmpty = z.string().trim().min(1).max(500);
const IsoDate = z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid ISO date');
const Cve = z.string().regex(/^CVE-\d{4}-\d{4,}$/i).transform(value => value.toUpperCase());

export const SecurityFeedFindingSchema = z.object({
  findingId: NonEmpty,
  ecosystem: z.string().trim().min(1).max(100),
  packageName: z.string().trim().min(1).max(300),
  installedVersion: z.string().trim().min(1).max(200),
});
export type SecurityFeedFinding = z.output<typeof SecurityFeedFindingSchema>;

export interface SecurityFeedProvenance {
  source: 'osv'|'cisa-kev';
  url: string;
  fetchedAt: string;
  expiresAt: string;
  bodySha256: string;
  cacheHit: boolean;
  etag: string|null;
  lastModified: string|null;
}

interface CachedDocument<T> { value:T; provenance:SecurityFeedProvenance; expiresAtMs:number }
type FetchLike = typeof fetch;

/** Reads a response incrementally so the configured byte limit also bounds memory use. */
export async function readBoundedHttpBody(response:Response,maxBytes:number,errorCode:string):Promise<Uint8Array>{
  const contentLength=response.headers.get('content-length');
  if(contentLength&&Number.isFinite(Number(contentLength))&&Number(contentLength)>maxBytes)throw new Error(errorCode);
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
  try{
    while(true){
      const chunk=await reader.read();if(chunk.done)break;
      total+=chunk.value.byteLength;
      if(total>maxBytes){await reader.cancel().catch(()=>undefined);throw new Error(errorCode);}
      chunks.push(chunk.value);
    }
  }finally{reader.releaseLock();}
  const result=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
  return result;
}

/** Bounded JSON retrieval with in-memory TTL cache. Only HTTPS and loopback HTTP are allowed. */
export class SecurityFeedHttpClient {
  private readonly cache = new Map<string,CachedDocument<unknown>>();
  constructor(private readonly fetcher:FetchLike=fetch, private readonly now:()=>number=Date.now) {}

  async json<T>(input:{
    source:SecurityFeedProvenance['source']; method:'GET'|'POST'; url:string; body?:unknown;
    ttlMs:number; timeoutMs:number; maxBytes:number; schema:z.ZodType<T>;
  }):Promise<{value:T;provenance:SecurityFeedProvenance}> {
    this.assertUrl(input.url);
    const body=input.body===undefined?undefined:JSON.stringify(input.body);
    const key=crypto.createHash('sha256').update(input.method+'\n'+input.url+'\n'+(body??'')).digest('hex');
    const cached=this.cache.get(key) as CachedDocument<T>|undefined;
    if(cached&&cached.expiresAtMs>this.now())return {value:cached.value,provenance:{...cached.provenance,cacheHit:true}};
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.min(Math.max(input.timeoutMs,100),30_000));
    let response:Response;let bytes:Uint8Array;
    try {
      response=await this.fetcher(input.url,{method:input.method,signal:controller.signal,headers:{
        accept:'application/json','content-type':'application/json','user-agent':'CodexInfra-SecurityFeeds/1',
      },redirect:'error',...(body?{body}:{})});
      if(!response.ok)throw new Error('security_feed_http_'+response.status);
      bytes=await readBoundedHttpBody(response,input.maxBytes,'security_feed_response_too_large');
    } finally {clearTimeout(timer);}
    let raw:unknown;
    try {raw=JSON.parse(Buffer.from(bytes).toString('utf8'));}
    catch {throw new Error('security_feed_invalid_json');}
    const value=input.schema.parse(raw);
    const fetchedAtMs=this.now();
    const ttlMs=Math.min(Math.max(input.ttlMs,1_000),24*60*60*1_000);
    const provenance:SecurityFeedProvenance={
      source:input.source,url:input.url,fetchedAt:new Date(fetchedAtMs).toISOString(),
      expiresAt:new Date(fetchedAtMs+ttlMs).toISOString(),
      bodySha256:crypto.createHash('sha256').update(bytes).digest('hex'),cacheHit:false,
      etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified'),
    };
    if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key,{value,provenance,expiresAtMs:fetchedAtMs+ttlMs});
    return {value,provenance};
  }

  private assertUrl(value:string):void {
    const url=new URL(value);
    const loopback=['127.0.0.1','localhost','::1'].includes(url.hostname);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw new Error('security_feed_url_not_allowed');
  }
}

const OsvVulnerabilitySchema=z.object({
  id:NonEmpty,aliases:z.array(NonEmpty).default([]),modified:IsoDate,
  published:IsoDate.optional(),summary:z.string().max(4000).optional(),
});
const OsvResponseSchema=z.object({vulns:z.array(OsvVulnerabilitySchema).default([]),next_page_token:z.string().min(1).optional()});
export interface OsvAdvisory {
  id:string; aliases:string[]; cves:string[]; modified:string; summary:string|null;
  ecosystem:string; packageName:string; installedVersion:string;
}
export interface OsvQueryReceipt {advisories:OsvAdvisory[];provenance:SecurityFeedProvenance[]}

export class OsvSecurityFeed {
  constructor(private readonly http:SecurityFeedHttpClient,private readonly baseUrl='https://api.osv.dev'){}
  async query(findings:SecurityFeedFinding[]):Promise<OsvQueryReceipt>{
    const packages=[...new Map(findings.map(item=>[this.key(item),item])).values()];
    if(packages.length===0||packages.length>25)throw new Error('security_feed_package_limit');
    const advisories:OsvAdvisory[]=[];const provenance:SecurityFeedProvenance[]=[];
    for(const item of packages){
      let pageToken:string|undefined;let pages=0;
      do{
        if(++pages>3)throw new Error('security_feed_osv_page_limit');
        const body={package:{ecosystem:item.ecosystem,name:item.packageName},version:item.installedVersion,...(pageToken?{page_token:pageToken}:{})};
        const document=await this.http.json({source:'osv',method:'POST',url:this.baseUrl+'/v1/query',body,
          ttlMs:30*60*1_000,timeoutMs:10_000,maxBytes:4*1024*1024,schema:OsvResponseSchema});
        provenance.push(document.provenance);
        for(const vulnerability of document.value.vulns){
          const aliases=[...new Set(vulnerability.aliases)];
          const cves=[...new Set([vulnerability.id,...aliases].filter(value=>/^CVE-\d{4}-\d{4,}$/i.test(value)).map(value=>value.toUpperCase()))];
          advisories.push({id:vulnerability.id,aliases,cves,modified:vulnerability.modified,
            summary:vulnerability.summary??null,ecosystem:item.ecosystem,packageName:item.packageName,installedVersion:item.installedVersion});
          if(advisories.length>500)throw new Error('security_feed_advisory_limit');
        }
        pageToken=document.value.next_page_token;
      }while(pageToken);
    }
    return {advisories,provenance};
  }
  private key(item:SecurityFeedFinding):string{return [item.ecosystem,item.packageName,item.installedVersion].join('\u0000');}
}

const KevEntrySchema=z.object({
  cveID:Cve,vendorProject:NonEmpty,product:NonEmpty,vulnerabilityName:NonEmpty,
  dateAdded:z.string().min(1).max(40),shortDescription:z.string().min(1).max(4000),
  requiredAction:z.string().min(1).max(4000),dueDate:z.string().min(1).max(40),
  knownRansomwareCampaignUse:z.string().min(1).max(100),notes:z.string().max(4000).default(''),
});
const KevCatalogSchema=z.object({
  title:NonEmpty,catalogVersion:NonEmpty,dateReleased:z.string().min(1).max(100),count:z.number().int().nonnegative(),
  vulnerabilities:z.array(KevEntrySchema).max(5000),
}).refine(value=>value.count===value.vulnerabilities.length,'KEV count does not match vulnerabilities');
export type KevEntry=z.output<typeof KevEntrySchema>;
export interface KevReceipt {catalogVersion:string;dateReleased:string;entries:Map<string,KevEntry>;provenance:SecurityFeedProvenance}

export class CisaKevSecurityFeed {
  static readonly officialUrl='https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
  constructor(private readonly http:SecurityFeedHttpClient,private readonly url=CisaKevSecurityFeed.officialUrl){}
  async read():Promise<KevReceipt>{
    const document=await this.http.json({source:'cisa-kev',method:'GET',url:this.url,
      ttlMs:6*60*60*1_000,timeoutMs:15_000,maxBytes:8*1024*1024,schema:KevCatalogSchema});
    return {catalogVersion:document.value.catalogVersion,dateReleased:document.value.dateReleased,
      entries:new Map(document.value.vulnerabilities.map(item=>[item.cveID,item])),provenance:document.provenance};
  }
}

export interface SecurityFeedCorrelationReceipt {
  version:1;generatedAt:string;expiresAt:string;
  findings:{findingId:string;packageName:string;installedVersion:string;status:'matched'|'not-matched';osvIds:string[];cves:string[];knownExploited:boolean|null}[];
  assertions:{findingId:string;kind:'applicability';value:true;source:'scanner';evidence:string}[];
  enrichments:{findingId:string;knownExploited:boolean;source:string;evidence:string;expiresAt:string}[];
  provenance:{osv:SecurityFeedProvenance[];kev:SecurityFeedProvenance|null};unknowns:string[];
}

/** Exact correlation only: package+version is resolved by OSV; finding ID/CVE aliases join OSV to KEV. */
export class SecurityFeedCorrelationService {
  constructor(private readonly osv:OsvSecurityFeed,private readonly kev:CisaKevSecurityFeed){}
  async correlate(rawFindings:SecurityFeedFinding[]):Promise<SecurityFeedCorrelationReceipt>{
    const findings=z.array(SecurityFeedFindingSchema).min(1).max(50).parse(rawFindings);
    const osvReceipt=await this.osv.query(findings);
    const matches=findings.map(finding=>{
      const key=[finding.ecosystem,finding.packageName,finding.installedVersion].join('\u0000');
      const id=finding.findingId.toUpperCase();
      const advisories=osvReceipt.advisories.filter(item=>[item.ecosystem,item.packageName,item.installedVersion].join('\u0000')===key
        &&[item.id,...item.aliases].some(alias=>alias.toUpperCase()===id));
      return {finding,advisories,cves:[...new Set(advisories.flatMap(item=>item.cves))]};
    });
    const needsKev=matches.some(item=>item.cves.length>0);
    const kevReceipt=needsKev?await this.kev.read():null;
    const correlated=matches.map(item=>{
      const knownExploited=kevReceipt?item.cves.some(cve=>kevReceipt.entries.has(cve)):null;
      return {findingId:item.finding.findingId,packageName:item.finding.packageName,installedVersion:item.finding.installedVersion,
        status:item.advisories.length?'matched' as const:'not-matched' as const,
        osvIds:[...new Set(item.advisories.map(advisory=>advisory.id))],cves:item.cves,
        knownExploited:item.advisories.length?knownExploited:null};
    });
    const assertions=correlated.filter(item=>item.status==='matched').map(item=>({
      findingId:item.findingId,kind:'applicability' as const,value:true as const,source:'scanner' as const,
      evidence:'OSV exact package/version query matched '+item.osvIds.join(', '),
    }));
    const enrichments=kevReceipt?correlated.filter(item=>item.status==='matched'&&item.cves.length>0).map(item=>({
      findingId:item.findingId,knownExploited:item.knownExploited===true,
      source:'CISA KEV '+kevReceipt.catalogVersion,
      evidence:item.knownExploited?'CISA KEV contains '+item.cves.filter(cve=>kevReceipt.entries.has(cve)).join(', ')
        :'Current CISA KEV catalog does not contain correlated CVE aliases',
      expiresAt:kevReceipt.provenance.expiresAt,
    })):[];
    const expiries=[...osvReceipt.provenance.map(item=>Date.parse(item.expiresAt)),...(kevReceipt?[Date.parse(kevReceipt.provenance.expiresAt)]:[])];
    const unknowns=[...correlated.filter(item=>item.status==='not-matched').map(item=>item.findingId+':osv_not_matched'),
      ...correlated.filter(item=>item.status==='matched'&&item.cves.length===0).map(item=>item.findingId+':cve_alias_missing')];
    return {version:1,generatedAt:new Date().toISOString(),expiresAt:new Date(Math.min(...expiries)).toISOString(),
      findings:correlated,assertions,enrichments,provenance:{osv:osvReceipt.provenance,kev:kevReceipt?.provenance??null},unknowns};
  }
}
