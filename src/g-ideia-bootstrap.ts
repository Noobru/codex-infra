import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {TaskEngine} from './engine.js';
import {KnowledgeFiles} from './knowledge-store.js';
import {ProfileSchema,ProjectRegistry,type Profile} from './registry.js';
import {atomicWriteNew,resolveRealSubPath} from './legacy/command-os-utils.js';

const start='<!-- codex-infra:g-ideia:v1:start -->';
const end='<!-- codex-infra:g-ideia:v1:end -->';
const noteKinds=['index','prd','prevc','spec','evidence'] as const;
type NoteKind=typeof noteKinds[number];
const labels:Record<NoteKind,string>={index:'Control Plane local',prd:'PRD',prevc:'PREVC',spec:'SPEC',evidence:'Evidências'};
const suffixes:Record<NoteKind,string>={index:'',prd:' - PRD',prevc:' - PREVC',spec:' - SPEC Tecnica',evidence:' - Evidencias'};
const absolutePath=z.string().min(1).refine(value=>path.isAbsolute(value),'Provide an explicit absolute path.');
const filename=z.string().min(4).max(200).refine(value=>value.endsWith('.md')&&!/[\\/<>:"|?*\x00-\x1f]/.test(value)
  &&!/[. ]$/.test(value)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),'Use a Markdown basename, without directories or reserved characters.');
export const GIdeiaProjectSchema=z.object({
  id:ProfileSchema.shape.id,name:z.string().trim().min(1).max(120).refine(value=>!/[\x00-\x1f]/.test(value)),
  code:z.string().regex(/^\d{3,6}$/),root:absolutePath,reuseExisting:z.boolean().default(false),
  filenames:z.object({index:filename.optional(),prd:filename.optional(),prevc:filename.optional(),spec:filename.optional(),evidence:filename.optional()}).strict().optional(),
  checks:ProfileSchema.shape.checks.optional(),
}).strict();
export const GIdeiaBootstrapInputSchema=z.object({
  vaultPath:absolutePath,project:GIdeiaProjectSchema.optional(),expectedContractSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type GIdeiaBootstrapInput=z.input<typeof GIdeiaBootstrapInputSchema>;
export interface GIdeiaInspection {
  vaultPath:string;contractPath:string;projectsPath:string;contractSha256:string;
  contractState:'missing-g-ideia'|'managed'|'existing'|'invalid-block';detectedBy:string;
}
export interface GIdeiaPlan {
  version:1;ready:boolean;issues:string[];
  contract:GIdeiaInspection&{action:'append'|'preserve'|'blocked';templatePath:string;templateSha256:string;
    proposedSha256:string;backupPath:string|null;changes:string[]};
  project:null|{id:string;name:string;root:string;reuseExisting:boolean;
    notes:{kind:NoteKind;path:string;action:'create'|'unchanged'|'reuse'|'conflict';sha256:string;templateSha256:string}[];
    profile:{action:'register'|'merge'|'unchanged'|'conflict';id:string;modes:Profile['modes'];checkIds:string[];sourceRoots:string[];sources:{label:string;path:string;kind:string}[]}};
  nextSteps:string[];
}
interface Prepared {plan:GIdeiaPlan;contractBytes:Buffer;contractAppend:string;noteTexts:Map<string,string>;profile:Profile|null}

/** Local, explicit bootstrap. It shares the registry/engine and never dispatches a task. */
export class GIdeiaBootstrap {
  readonly root:string;
  readonly templateRoot:string;
  constructor(infraRoot:string,templateRoot?:string){
    this.root=path.resolve(infraRoot);this.templateRoot=path.resolve(templateRoot??path.join(this.root,'templates/g-ideia'));
  }

  async inspect(input:{vaultPath:string}):Promise<GIdeiaInspection>{
    absolutePath.parse(input.vaultPath);
    const vaultPath=await fs.realpath(input.vaultPath);
    if(!(await fs.stat(vaultPath)).isDirectory())throw new Error('Vault must be an existing directory.');
    const contractPath=path.join(vaultPath,'AGENTS.md'),projectsPath=path.join(vaultPath,'600 - Projetos');
    for(const [file,directory] of [[contractPath,false],[projectsPath,true]] as const){
      const stat=await fs.lstat(file);
      if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||!await resolveRealSubPath(file,vaultPath)){
        throw new Error('Vault requires a local AGENTS.md and a local 600 - Projetos directory.');
      }
    }
    if((await fs.stat(contractPath)).size>2*1024*1024)throw new Error('Vault contract exceeds the 2 MiB inspection budget.');
    const bytes=await fs.readFile(contractPath),text=bytes.toString('utf8');
    const starts=text.split(start).length-1,ends=text.split(end).length-1;
    const managed=starts===1&&ends===1&&text.indexOf(start)<text.indexOf(end);
    const malformed=(starts>0||ends>0)&&!managed;
    const existing=/\bG[ -]?IDEIA\b/i.test(text);
    return {vaultPath,contractPath,projectsPath,contractSha256:KnowledgeFiles.hash(bytes),
      contractState:malformed?'invalid-block':managed?'managed':existing?'existing':'missing-g-ideia',
      detectedBy:malformed?'incomplete or repeated managed delimiters':managed?'managed delimiters':existing?'explicit G-IDEIA text':'no G-IDEIA marker'};
  }

  async plan(input:GIdeiaBootstrapInput):Promise<GIdeiaPlan>{return (await this.prepare(input)).plan;}

  async applyContract(input:{vaultPath:string;expectedContractSha256?:string}){return this.apply(input);}

  async scaffoldProject(input:GIdeiaBootstrapInput&{project:NonNullable<GIdeiaBootstrapInput['project']>}){return this.apply(input);}

  async apply(input:GIdeiaBootstrapInput){
    const inspection=await this.inspect(input),lockPath=path.join(inspection.vaultPath,'.codex-infra-g-ideia.lock');
    let lock:Awaited<ReturnType<typeof fs.open>>;
    try{lock=await fs.open(lockPath,'wx');}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('G-IDEIA bootstrap is in progress or its abandoned lock needs review.');throw error;}
    try{
      const prepared=await this.prepare(input),{plan}=prepared;
      if(!plan.ready)throw new Error('Bootstrap plan is blocked: '+plan.issues.join(' '));
      if(plan.contract.action==='append'){
        await this.exclusiveSame(plan.contract.backupPath!,prepared.contractBytes);
        if(KnowledgeFiles.hash(await fs.readFile(plan.contract.contractPath))!==plan.contract.contractSha256){
          throw new Error('Vault contract changed after inspection; review the new plan.');
        }
        await fs.appendFile(plan.contract.contractPath,prepared.contractAppend,'utf8');
        if(KnowledgeFiles.hash(await fs.readFile(plan.contract.contractPath))!==plan.contract.proposedSha256){
          throw new Error('Contract readback differs; preserve the backup and review AGENTS.md.');
        }
      }
      for(const note of plan.project?.notes??[]){
        if(note.action==='create')await this.exclusiveSame(note.path,Buffer.from(prepared.noteTexts.get(note.path)!));
        else if(KnowledgeFiles.hash(await fs.readFile(note.path))!==note.sha256)throw new Error('Project note changed after inspection: '+note.path);
      }
      let profile:Profile|null=null;
      if(prepared.profile){
        await fs.mkdir(path.join(this.root,'profiles'),{recursive:true});
        const engine=new TaskEngine(this.root);
        try{profile=await engine.profiles.register(prepared.profile,plan.project!.profile.action==='merge');}
        finally{engine.state.close();}
      }
      return {version:1,applied:true,contractAction:plan.contract.action,contractPath:plan.contract.contractPath,
        contractSha256:KnowledgeFiles.hash(await fs.readFile(plan.contract.contractPath)),backupPath:plan.contract.backupPath,
        backupSha256:plan.contract.backupPath?KnowledgeFiles.hash(await fs.readFile(plan.contract.backupPath)):null,
        notes:plan.project?.notes??[],profileId:profile?.id??null,profileAction:plan.project?.profile.action??null,
        executedJobs:0,notionState:'not-synchronized',nextSteps:plan.nextSteps};
    }finally{await lock.close();await fs.unlink(lockPath);}
  }

  private async prepare(raw:GIdeiaBootstrapInput):Promise<Prepared>{
    const input=GIdeiaBootstrapInputSchema.parse(raw),inspection=await this.inspect(input);
    const issues:string[]=[],contractBytes=await fs.readFile(inspection.contractPath);
    if(input.expectedContractSha256&&input.expectedContractSha256!==inspection.contractSha256)issues.push('Contract SHA differs from the reviewed input.');
    if(inspection.contractState==='invalid-block')issues.push('Managed contract block is incomplete or repeated; reconcile it using the local backup.');
    const contractTemplate=await this.template('contract');
    const tokens:Record<string,string>={vaultPath:inspection.vaultPath,infraRoot:this.root};
    const project=input.project;
    let projectRoot:string|null=null,files:Record<NoteKind,string>|null=null;
    if(project){
      projectRoot=await fs.realpath(project.root);
      if(!(await fs.stat(projectRoot)).isDirectory())throw new Error('Project root must already exist; bootstrap does not create or run a product.');
      const base=`${project.code} - ${project.name.replace(/[\\/<>:"|?*]/g,'-')}`;
      files=Object.fromEntries(noteKinds.map(kind=>[kind,filename.parse(project.filenames?.[kind]??base+suffixes[kind]+'.md')])) as Record<NoteKind,string>;
      if(new Set(Object.values(files).map(value=>value.toLocaleLowerCase())).size!==noteKinds.length)throw new Error('Project note filenames must be distinct.');
      Object.assign(tokens,{projectName:project.name,projectId:project.id,projectCode:project.code,projectRoot,
        ...Object.fromEntries(noteKinds.map(kind=>[kind+'File',files![kind]]))});
    }
    const newline=contractBytes.includes(Buffer.from('\r\n'))?'\r\n':'\n';
    const renderedContract=this.render(contractTemplate.text,tokens);
    const contractAppend=newline+newline+start+newline+renderedContract.replace(/\r?\n/g,newline).trimEnd()+newline+end+newline;
    const contractAction=inspection.contractState==='missing-g-ideia'?'append':inspection.contractState==='invalid-block'?'blocked':'preserve';
    const proposed=contractAction==='append'?Buffer.concat([contractBytes,Buffer.from(contractAppend)]):contractBytes;
    const plan:GIdeiaPlan={version:1,ready:false,issues,
      contract:{...inspection,action:contractAction,templatePath:contractTemplate.path,templateSha256:contractTemplate.sha256,
        proposedSha256:KnowledgeFiles.hash(proposed),backupPath:contractAction==='append'?inspection.contractPath+'.g-ideia-'+inspection.contractSha256+'.bak':null,
        changes:contractAction==='append'?['Preserve every existing byte.','Save a byte-exact local backup.','Append one delimited G-IDEIA contract block.']:
          ['Preserve the existing contract; detection is provenance, not verification of its completeness.']},
      project:null,nextSteps:['Read and reconcile the local contract and project documents before engineering.','Synchronize canonical Notion artifacts and tracking when applicable; no Notion page was created by this bootstrap.']};
    const noteTexts=new Map<string,string>();
    let profile:Profile|null=null;
    if(project&&projectRoot&&files){
      const notes:NonNullable<GIdeiaPlan['project']>['notes']=[];
      const siblingNames=await fs.readdir(inspection.projectsPath);
      if(!project.reuseExisting&&siblingNames.some(name=>name.startsWith(project.code+' - ')&&!Object.values(files!).includes(name))){
        issues.push('Other notes already use this project code. Locate its canonical artifacts; use explicit filenames and reuseExisting or choose the correct code.');
      }
      for(const kind of noteKinds){
        const template=await this.template(kind),target=path.join(inspection.projectsPath,files[kind]),text=this.render(template.text,tokens);
        noteTexts.set(target,text);
        const stat=await fs.lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
        if(stat&&(!stat.isFile()||stat.isSymbolicLink()||!await resolveRealSubPath(target,inspection.vaultPath)))throw new Error('Canonical note must be a local regular file: '+target);
        const existing=stat?await fs.readFile(target):null,sha256=KnowledgeFiles.hash(existing??text);
        const same=existing!==null&&sha256===KnowledgeFiles.hash(text);
        const action=existing===null?'create':same?'unchanged':project.reuseExisting?'reuse':'conflict';
        if(action==='conflict')issues.push('Existing canonical note will not be overwritten: '+target+'. Use reuseExisting to bind it, or reconcile the profile manually.');
        notes.push({kind,path:target,action,sha256,templateSha256:template.sha256});
      }
      const registry=new ProjectRegistry(path.join(this.root,'profiles/registry.json')),profiles=await registry.list();
      const existing=profiles.find(item=>item.id===project.id);
      const sources:Profile['sources']=[{path:inspection.contractPath,label:'Contrato coding',kind:'instruction',maxChars:12000},
        ...notes.map(note=>({path:note.path,label:labels[note.kind],kind:'reference' as const,maxChars:6000}))];
      let profileAction:NonNullable<GIdeiaPlan['project']>['profile']['action']='register';
      if(existing){
        profileAction='merge';
        if(!KnowledgeFiles.samePath(existing.root,projectRoot))issues.push('Existing profile points to another root; select the correct ID instead of replacing it.');
        const merged=[...existing.sources];
        for(const source of sources){
          const present=merged.find(candidate=>candidate.label===source.label);
          if(present&&!KnowledgeFiles.samePath(path.resolve(existing.root,present.path),source.path))issues.push('Profile label already points to another source: '+source.label+'. Correct the binding explicitly.');
          else if(!present)merged.push(source);
        }
        profile=ProfileSchema.parse({...existing,sources:merged,sourceRoots:existing.sourceRoots.some(root=>KnowledgeFiles.samePath(root,inspection.vaultPath))?existing.sourceRoots:[...existing.sourceRoots,inspection.vaultPath]});
        if(registry.hash(existing)===registry.hash(profile))profileAction='unchanged';
        if(project.checks)plan.nextSteps.push('Existing profile checks and modes were preserved; change them separately through ProfileManager if necessary.');
      }else{
        profile=ProfileSchema.parse({id:project.id,name:project.name,root:projectRoot,status:'active',stack:[],modes:['read-only'],
          workspaces:['in-place','worktree'],sourceRoots:[inspection.vaultPath],sources,checks:project.checks??[]});
        const key=project.name.trim().toLocaleLowerCase('pt-BR');
        if(profiles.some(other=>[other.id,other.name,...other.aliases].some(value=>value.toLocaleLowerCase('pt-BR')===key||value.toLocaleLowerCase('pt-BR')===project.id)))issues.push('Project name or ID conflicts with another registered profile.');
      }
      if(issues.length)profileAction='conflict';
      plan.project={id:project.id,name:project.name,root:projectRoot,reuseExisting:project.reuseExisting,notes,
        profile:{action:profileAction,id:profile.id,modes:profile.modes,checkIds:profile.checks.map(check=>check.id),sourceRoots:profile.sourceRoots,
          sources:profile.sources.map(({label,path,kind})=>({label,path,kind}))}};
      if(!profile.checks.length)plan.nextSteps.push('This profile supports planning/context only until real acceptance checks are registered; bootstrap executes no check.');
      plan.nextSteps.push('For task_context, require source labels: Contrato coding, PRD, PREVC. Newly created documents are drafts, and reused documents still need reconciliation.');
    }
    plan.ready=issues.length===0;
    return {plan,contractBytes,contractAppend,noteTexts,profile};
  }

  private async template(name:string){
    const file=path.join(this.templateRoot,name+'.md'),resolved=await resolveRealSubPath(file,this.templateRoot);
    if(!resolved)throw new Error('G-IDEIA template is missing or outside its directory: '+name);
    const text=await fs.readFile(resolved,'utf8');
    return {path:resolved,text,sha256:KnowledgeFiles.hash(text)};
  }
  private render(template:string,tokens:Record<string,string>){
    return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g,(_match,key:string)=>{
      if(tokens[key]===undefined)throw new Error('Template requires an unavailable token: '+key);
      return tokens[key]!;
    });
  }
  private async exclusiveSame(target:string,bytes:Buffer){
    try{await atomicWriteNew(target,bytes);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(KnowledgeFiles.hash(await fs.readFile(target))!==KnowledgeFiles.hash(bytes))throw new Error('Existing file differs; bootstrap never overwrites: '+target);
    }
  }
}
