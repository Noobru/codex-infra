import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ProcessRunner} from './process.js';
import {KnowledgeFiles, KnowledgeOwnerDecisionSchema} from './knowledge-store.js';
import {EvidenceSanitizer} from './evidence.js';

const inventorySchema=z.object({owners:z.array(z.object({ProcessName:z.string(),Id:z.number()})),knownSocketError:z.boolean(),
  directories:z.array(z.object({relative:z.string(),exists:z.boolean(),safe:z.boolean(),entries:z.array(z.object({name:z.string(),socketEntry:z.boolean(),known:z.boolean()}))}))});
export type DockerSocketInventory=z.output<typeof inventorySchema>;
const quarantineSchema=z.object({quarantined:z.array(z.object({original:z.string(),preserved:z.string()})),deleted:z.literal(false),error:z.string().optional()});
export interface DockerRecoveryHost {
  inspect():Promise<DockerSocketInventory>;
  healthy():Promise<boolean>;
  quarantine():Promise<unknown>;
  start():Promise<void>;
}
/** Host-only operation; never called by the offline learning sandbox or an automatic learning event. */
export class WindowsDockerRecoveryHost implements DockerRecoveryHost {
  private readonly runner=new ProcessRunner();
  constructor(private readonly root:string){}
  private async command(executable:string,args:string[],timeout=15000){
    return this.runner.run(executable,args,this.root,timeout);
  }
  private async script(action:'Inspect'|'Quarantine') {
    if(process.platform!=='win32')throw new Error('Docker socket recovery is Windows-only.');
    const result=await this.command('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(this.root,'scripts/Docker-SocketRecovery.ps1'),'-Action',action]);
    if(result.exitCode!==0)throw new Error(EvidenceSanitizer.text(result.stderr||result.error||'Docker socket inspection failed',2000));
    return JSON.parse(result.stdout);
  }
  async inspect(){return inventorySchema.parse(await this.script('Inspect'));}
  async quarantine(){return quarantineSchema.parse(await this.script('Quarantine'));}
  async healthy(){
    const result=await this.command('docker.exe',['--host','npipe:////./pipe/dockerDesktopLinuxEngine','info','--format','{{.OSType}}']);
    return result.exitCode===0 && result.stdout.trim()==='linux';
  }
  async start(){
    // Detached Desktop startup is not a child service owned by ProcessRunner's timeout cleanup.
    const result=await this.command('docker.exe',['desktop','start','--detach'],30000);
    if(result.exitCode!==0)throw new Error(EvidenceSanitizer.text(result.stderr||result.error||'Docker Desktop start failed',2000));
  }
}

export class DockerRecovery {
  /** Host lifecycle guidance is shared by every project; it is not a learned project capability. */
  static startupPolicy() {
    return {scope:'host' as const,skill:'start-docker',projectBindingRequired:false,
      inspectTool:'inspect_docker_recovery',startTool:'recover_docker_start',
      guidance:'Before opening Docker Desktop for any project or a projectless task, use the installed start-docker skill. Call inspect_docker_recovery first; when startup is authorized and needed, use recover_docker_start, then confirm healthy:true. Do not launch Docker Desktop.exe, Start-Process or docker desktop start directly. Keep the current project identity; this host operation needs no codex-infra project selection. Reuse existing startup authorization; this guidance grants no new authority to start, stop or reset services.'};
  }
  private readonly host:DockerRecoveryHost;
  constructor(readonly root:string,host?:DockerRecoveryHost){this.host=host??new WindowsDockerRecoveryHost(root);}
  async inspect(){
    const inventory=await this.host.inspect(),healthy=await this.host.healthy();
    const hasOrphanEntries=inventory.directories.some(item=>item.exists&&item.entries.length>0);
    const status=healthy?'healthy':inventory.owners.length?'docker-active':!inventory.directories.every(item=>item.safe)?'manual-inspection':hasOrphanEntries?'orphan-sockets':'docker-stopped';
    return {status,healthy,...inventory,nextAction:healthy?'No recovery required.':status==='orphan-sockets'?'With existing owner startup authorization, use recover_docker_start to preserve both known socket directories and start Docker once. Do not preserve sockets or start Docker manually.':status==='docker-stopped'?'With existing owner startup authorization, use recover_docker_start to start Docker once; no socket quarantine is needed.':status==='docker-active'?'Wait for startup or close the failed Docker instance before recovery.':'Inspect the current failure before changing files.'};
  }
  async recover(raw:unknown){
    const decision=KnowledgeOwnerDecisionSchema.parse(raw),before=await this.inspect();
    if(before.healthy)return {status:'healthy',changed:false,before};
    if(before.status!=='orphan-sockets'&&before.status!=='docker-stopped')throw new Error(before.nextAction);
    const id=randomUUID(),files=new KnowledgeFiles(this.root),base=`artifacts/integration/docker-recovery/${id}`;
    await files.writeJsonNew(base+'/intent.json',{version:1,id,recordedAt:new Date().toISOString(),decision,before});
    let preserved:unknown=null;
    try {
      if(before.status==='orphan-sockets') {
        preserved=quarantineSchema.parse(await this.host.quarantine());
        await files.writeJsonNew(base+'/preserved.json',{preserved,recordedAt:new Date().toISOString()});
        const failure=quarantineSchema.parse(preserved).error;
        if(failure)throw new Error(failure);
      }
      await this.host.start();
      // Confirmation is a separate read-only call after startup; never infer health from launch success.
      const after=await this.inspect();
      const receipt={version:1,id,status:after.healthy?'healthy':'starting-or-failed',changed:true,preserved,before,after,artifactPath:base+'/result.json'};
      await files.writeJsonNew(receipt.artifactPath,receipt);return receipt;
    } catch(error){
      await files.writeJsonNew(base+'/failure.json',{version:1,id,preserved,error:EvidenceSanitizer.text(String(error),2000),recordedAt:new Date().toISOString()});throw error;
    }
  }
}
