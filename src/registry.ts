import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readJson, resolveRealSubPath } from "./legacy/command-os-utils.js";
import { ProcessCleanupError, ProcessRunner, type CommandResult, type CommandOptions } from "./process.js";
import { SecurityStageSchema } from './security-gate.js';

const SecurityPublisherConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/),
  kind: z.literal('github-check'),
  target: z.string().trim().min(1).max(500),
  enabled: z.boolean().default(false),
  stages: z.array(SecurityStageSchema).min(1).default(['ci']),
});

const SourceMetadataSchema = z.object({
  topics:z.array(z.string().min(1)).optional(),
  knowledgeStatus:z.enum(['active','historical','candidate']).optional(),
  validUntil:z.iso.datetime().optional(),
  knowledgeClass:z.enum(['research','decision','pattern','candidate','canonical','historical']).optional(),
  decisionRefs:z.array(z.string().trim().min(1).max(2000)).max(40).optional(),
  precedence:z.number().int().optional(),
  conflictsWith:z.array(z.string().trim().min(1).max(240)).max(40).optional(),
});
const SourceSchema = z.object({path:z.string().min(1), label:z.string().min(1), kind:z.enum(["instruction","reference","evidence"]), maxChars:z.number().int().min(1).max(12000).default(4000)}).extend(SourceMetadataSchema.shape);
const CheckSchema = z.object({id:z.string().min(1), executable:z.string().min(1), args:z.array(z.string()), relativeCwd:z.string().default("."), readOnly:z.boolean(), timeoutMs:z.number().int().min(100).max(7200000).default(30000),adapter:z.enum(['command']).default('command'),environmentPaths:z.array(z.string().min(1)).default([])});
export const ProfileSchema = z.object({
 id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), name:z.string().min(1), aliases:z.array(z.string().min(1)).default([]),
 root:z.string().min(1), status:z.enum(["active","paused"]), stack:z.array(z.string()),
 modes:z.array(z.enum(["read-only","workspace-write"])).min(1),
 workspaces:z.array(z.enum(["in-place","worktree"])).min(1).default(["in-place"]),
 sourceRoots:z.array(z.string()), sources:z.array(SourceSchema), checks:z.array(CheckSchema),
 securityPublisher:SecurityPublisherConfigSchema.optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export interface ContextSource extends z.infer<typeof SourceMetadataSchema> {path:string; label:string; kind:string; sha256:string; modifiedAt:string; totalChars:number; excerpt:string; truncated:boolean}
export interface ProjectContext {projectId:string; root:string; profileHash:string; capturedAt:string; git:{head:string|null; status:string; error:string|null}; sources:ContextSource[]}
export interface CheckOptions extends CommandOptions { execution?: {jobId:string;attempt:number;baseSha:string|null;targetSha:string|null;artifactDir:string} }
export class ProjectRegistry {
  constructor(readonly registryPath:string, private runner=new ProcessRunner()) {}
  async list():Promise<Profile[]> {
    const raw=await readJson(this.registryPath,{version:1,projects:[]}) as {version:number;projects:unknown[]};
    if(raw.version!==1 || !Array.isArray(raw.projects)) throw new Error("Unsupported registry version");
    const profiles=raw.projects.map(p=>ProfileSchema.parse(p));
    if(new Set(profiles.map(p=>p.id)).size!==profiles.length) throw new Error("Duplicate project ID");
    return profiles;
  }
  async resolve(query:string):Promise<Profile> {
    const key=query.trim().toLocaleLowerCase("pt-BR");
    const matches=(await this.list()).filter(p=>[p.id,p.name,...p.aliases].some(n=>n.toLocaleLowerCase("pt-BR")===key));
    if(matches.length===0) throw new Error("Unknown project: "+query);
    if(matches.length>1) throw new Error("Ambiguous project: "+matches.map(p=>p.id).join(", "));
    const profile=matches[0]!;
    const root = await fs.realpath(profile.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Project root is not a directory');
    return {...profile,root};
  }
  hash(profile:Profile):string {return createHash("sha256").update(JSON.stringify(profile)).digest("hex");}
  assertMode(profile:Profile, mode:"read-only"|"workspace-write"):void {
    if(!profile.modes.includes(mode)) throw new Error("Mode not allowed for this project");
    if(profile.status==="paused" && mode!=="read-only") throw new Error("Project is paused; mutation is not authorized");
  }
  async context(profile:Profile):Promise<ProjectContext> {
    const sources:ContextSource[]=[];
    for(const source of profile.sources) {
      const candidate=path.isAbsolute(source.path)?source.path:path.resolve(profile.root,source.path);
      let resolved:string|null=null;
      for(const root of [profile.root,...profile.sourceRoots]) {resolved=await resolveRealSubPath(candidate,root);if(resolved)break;}
      if(!resolved) throw new Error("Context source is missing or outside allowed roots: "+source.label);
      const stat=await fs.stat(resolved);
      if(stat.size>2*1024*1024)throw new Error("Context source exceeds file size budget: "+source.label);
      const buffer=await fs.readFile(resolved);
      const text=buffer.toString("utf8");
      sources.push({path:resolved,label:source.label,kind:source.kind,sha256:createHash("sha256").update(buffer).digest("hex"),modifiedAt:stat.mtime.toISOString(),totalChars:text.length,excerpt:text.slice(0,source.maxChars),truncated:text.length>source.maxChars,...SourceMetadataSchema.parse(source)});
    }
    const [head,status]=await Promise.all([
      this.runner.run("git",["--no-optional-locks","rev-parse","HEAD"],profile.root,10000),
      this.runner.run("git",["--no-optional-locks","status","--porcelain=v1","--branch"],profile.root,10000)
    ]);
    const unconfirmedCleanup=[head,status].find(result=>result.cleanupFailed);
    if(unconfirmedCleanup)throw new ProcessCleanupError(unconfirmedCleanup);
    return {projectId:profile.id,root:profile.root,profileHash:this.hash(profile),capturedAt:new Date().toISOString(),git:{head:head.exitCode===0?head.stdout.trim():null,status:status.stdout,error:status.exitCode===0?null:status.error??status.stderr},sources};
  }
  async resolveEnvironmentPaths(profile:Profile,check:Profile['checks'][number]):Promise<string[]> {
    const paths:string[]=[];
    for(const configured of check.environmentPaths) {
      try {
        const directory=await fs.realpath(path.resolve(profile.root,configured));
        if(!(await fs.stat(directory)).isDirectory())throw new Error('Not a directory');
        paths.push(directory);
      } catch {throw new Error(`Check environment directory is unavailable: ${profile.id}/${check.id}`);}
    }
    return paths;
  }
  async check(profile:Profile,checkId:string,mode:"read-only"|"workspace-write",options:CheckOptions={}):Promise<CommandResult & {checkId:string}> {
    this.assertMode(profile,mode);
    const check=profile.checks.find(c=>c.id===checkId);
    if(!check)throw new Error("Unknown check: "+checkId);
    if(mode==="read-only" && !check.readOnly)throw new Error("Check is not declared read-only");
    const cwd=await resolveRealSubPath(path.resolve(profile.root,check.relativeCwd),profile.root);
    if(!cwd)throw new Error("Check CWD outside project");
    const pathPrepend=await this.resolveEnvironmentPaths(profile,check);
    return {checkId,...await this.runner.run(check.executable,check.args,cwd,check.timeoutMs,{...options,pathPrepend})};
  }
}
