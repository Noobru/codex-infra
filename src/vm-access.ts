import fs from 'node:fs/promises';
import path from 'node:path';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ProcessRunner, type CommandResult} from './process.js';
import {KnowledgeFiles} from './knowledge-store.js';
import {EvidenceSanitizer} from './evidence.js';
import {atomicWriteJson} from './legacy/command-os-utils.js';

const id=z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const vmName=z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/);
const user=z.string().trim().min(1).max(64).regex(/^[a-z_][a-z0-9_-]*$/i);
const sha256Fingerprint=z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/);
const absolutePath=z.string().trim().min(1).max(4096).refine(value=>path.isAbsolute(value)||path.win32.isAbsolute(value),'Expected an absolute path.');
const guestPath=z.string().trim().min(1).max(1024).regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
const literalIp=z.string().refine(value=>isIP(value)!==0,'Expected a literal IPv4 or IPv6 address.');

export const VmAccessProfileSchema=z.enum(['offline','bridge']);
export const VmAccessHostSshSchema=z.object({
  host:z.literal('127.0.0.1'),port:z.number().int().min(1024).max(65535),user,
  identityFile:absolutePath,knownHostsFile:absolutePath,expectedHostKeyFingerprint:sha256Fingerprint,
}).strict();
export const VmAccessBridgeSchema=z.object({
  targetHost:literalIp,targetPort:z.number().int().min(1).max(65535),targetUser:user,
  guestIdentityFile:guestPath,guestKnownHostsFile:guestPath,expectedHostKeyFingerprint:sha256Fingerprint,
}).strict();
export const VmAccessConfigSchema=z.object({
  resourceId:id,ownerId:id,baseVmName:vmName,vmName,profile:VmAccessProfileSchema,
  storageRoot:absolutePath,
  tools:z.object({vboxManagePath:absolutePath,sshPath:absolutePath,sshKeygenPath:absolutePath}).strict(),
  hostSsh:VmAccessHostSshSchema.optional(),
  bridge:VmAccessBridgeSchema.optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.baseVmName===value.vmName)ctx.addIssue({code:'custom',path:['vmName'],message:'The clone name must differ from the preserved base VM.'});
  if(value.profile==='bridge'&&!value.bridge)ctx.addIssue({code:'custom',path:['bridge'],message:'Bridge profile requires an explicit target and guest-only credential references.'});
  if(value.profile==='bridge'&&!value.hostSsh)ctx.addIssue({code:'custom',path:['hostSsh'],message:'Bridge profile requires explicit host-to-guest SSH references.'});
  if(value.profile==='offline'&&value.bridge)ctx.addIssue({code:'custom',path:['bridge'],message:'Offline profile cannot carry a bridge target.'});
  if(value.profile==='offline'&&value.hostSsh)ctx.addIssue({code:'custom',path:['hostSsh'],message:'Offline profile has no NIC and cannot carry host SSH configuration.'});
});
export type VmAccessConfig=z.output<typeof VmAccessConfigSchema>;

export const VmAccessSelectorSchema=z.object({resourceId:id,ownerId:id}).strict();
export type VmAccessSelector=z.output<typeof VmAccessSelectorSchema>;
export const VmAccessPreviewInputSchema=z.object({config:VmAccessConfigSchema}).strict();
export const VmAccessPrepareInputSchema=VmAccessPreviewInputSchema;
export const VmAccessInspectInputSchema=VmAccessSelectorSchema;
export const VmAccessStartInputSchema=VmAccessSelectorSchema;
export const VmAccessValidateInputSchema=VmAccessSelectorSchema;
export const VmAccessCloseInputSchema=VmAccessSelectorSchema;
export const VmAccessSessionInputSchema=VmAccessSelectorSchema;

export const VmHostObservationSchema=z.object({
  exists:z.boolean(),powerState:z.enum(['poweroff','running','saved','aborted','unknown']),uuid:z.string().nullable(),
  nics:z.array(z.string().nullable()).length(8),forwardingRules:z.array(z.string()),sharedFolderCount:z.number().int().min(0),
  hostIntegrationsDisabled:z.boolean(),
}).strict();
export type VmHostObservation=z.output<typeof VmHostObservationSchema>;
export const VmProbeResultSchema=z.object({
  guestReady:z.boolean().nullable(),networkProfile:z.enum(['offline','bridge']),hostIdentityVerified:z.boolean().nullable(),
  targetIdentityVerified:z.boolean().nullable(),targetReached:z.boolean().nullable(),details:z.array(z.string().max(1000)).max(20),
}).strict();
export type VmProbeResult=z.output<typeof VmProbeResultSchema>;

export const VmAccessStateSchema=z.object({
  version:z.literal(1),resourceId:id,ownerId:id,desiredHash:z.string().regex(/^[a-f0-9]{64}$/),config:VmAccessConfigSchema,
  vmUuid:z.string().min(1).nullable(),
  status:z.enum(['preparing','prepared','running','validated','closed','failed']),
  createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),lastOperation:z.enum(['prepare','start','validate','close']),
  lastError:z.string().max(2000).nullable(),
}).strict();
export type VmAccessState=z.output<typeof VmAccessStateSchema>;

export const VmAccessResultSchema=z.object({
  operation:z.enum(['preview','prepare','inspect','start','validate','close']),resourceId:id,
  status:z.string(),changed:z.boolean(),reused:z.boolean(),desiredHash:z.string().regex(/^[a-f0-9]{64}$/),
  observation:VmHostObservationSchema,state:VmAccessStateSchema.nullable(),probe:VmProbeResultSchema.optional(),receiptPath:z.string().optional(),
}).strict();
export type VmAccessResult=z.output<typeof VmAccessResultSchema>;

export const VmAccessSessionCommandSchema=z.object({executable:absolutePath,args:z.array(z.string().min(1)).min(1)}).strict();
export type VmAccessSessionCommand=z.output<typeof VmAccessSessionCommandSchema>;

export function buildVmAccessBridgeSessionCommand(config:VmAccessConfig):VmAccessSessionCommand{
  if(config.profile!=='bridge'||!config.bridge||!config.hostSsh)throw new Error('An interactive session requires the validated bridge profile.');
  const access=config.hostSsh,bridge=config.bridge;
  const inner=`exec ssh -F none -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${bridge.guestKnownHostsFile} -o GlobalKnownHostsFile=none -o ForwardAgent=no -o ClearAllForwardings=yes -p ${bridge.targetPort} -i ${bridge.guestIdentityFile} ${bridge.targetUser}@${bridge.targetHost}`;
  return VmAccessSessionCommandSchema.parse({executable:config.tools.sshPath,args:['-F','none','-tt','-o','IdentitiesOnly=yes','-o',`UserKnownHostsFile=${access.knownHostsFile}`,
    '-o','GlobalKnownHostsFile=none','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-p',String(access.port),'-i',access.identityFile,
    `${access.user}@${access.host}`,inner]});
}

export interface VmAccessHostAdapter {
  inspect(vmName:string,config?:VmAccessConfig):Promise<VmHostObservation>;
  clone(config:VmAccessConfig):Promise<void>;
  configure(config:VmAccessConfig):Promise<void>;
  start(config:VmAccessConfig):Promise<void>;
  validate(config:VmAccessConfig):Promise<VmProbeResult>;
  close(config:VmAccessConfig):Promise<void>;
}

function assertConfiguredVmHost(config:VmAccessConfig,observation:VmHostObservation,requireRunning=false){
    if(!observation.exists||(requireRunning&&observation.powerState!=='running'))throw new Error('VM runtime does not match the requested resource.');
    const expectedNic1=config.profile==='offline'?'none':'nat';
    if(observation.nics[0]!==expectedNic1||observation.nics.slice(1).some(value=>value!=='none'))throw new Error('Prepared VM does not have the requested isolated NIC configuration.');
    const expectedForward=config.profile==='bridge'?[`vmaccess-ssh,tcp,127.0.0.1,${config.hostSsh!.port},,22`]:[];
    if(observation.forwardingRules.length!==expectedForward.length||observation.forwardingRules.some((value,index)=>value!==expectedForward[index]))throw new Error('Prepared VM does not have the exact requested forwarding configuration.');
    if(observation.sharedFolderCount!==0||!observation.hostIntegrationsDisabled)throw new Error('Prepared VM still exposes a host integration.');
  }

type Runner=Pick<ProcessRunner,'run'>;

/** VirtualBox/OpenSSH implementation. It executes only when a caller invokes a mutating service method. */
export class VirtualBoxVmAccessHost implements VmAccessHostAdapter {
  constructor(private readonly root:string,private readonly runner:Runner=new ProcessRunner()){}
  private async command(executable:string,args:string[],timeoutMs=30_000,allowNonZero=false):Promise<CommandResult>{
    const result=await this.runner.run(executable,args,this.root,timeoutMs);
    if(!allowNonZero&&result.exitCode!==0)throw new Error(this.safeCommandError(result));
    return result;
  }
  private safeCommandError(result:CommandResult){return EvidenceSanitizer.text(result.stderr||result.error||`Command failed with exit code ${result.exitCode}`,2000);}
  private async vbox(config:VmAccessConfig,args:string[],timeoutMs=30_000,allowNonZero=false){return this.command(config.tools.vboxManagePath,args,timeoutMs,allowNonZero);}
  private hostAccess(config:VmAccessConfig){if(!config.hostSsh)throw new Error('Host SSH is unavailable for an offline VM.');return config.hostSsh;}
  private sshArgs(config:VmAccessConfig,remote:string){
    const access=this.hostAccess(config);
    return ['-F','none','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','IdentitiesOnly=yes','-o',`UserKnownHostsFile=${access.knownHostsFile}`,
      '-o','GlobalKnownHostsFile=none','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-p',String(access.port),'-i',access.identityFile,
      `${access.user}@${access.host}`,remote];
  }
  private async ssh(config:VmAccessConfig,remote:string,allowNonZero=false){return this.command(config.tools.sshPath,this.sshArgs(config,remote),30_000,allowNonZero);}
  async inspect(vmNameValue:string,config?:VmAccessConfig):Promise<VmHostObservation>{
    const parsedName=vmName.parse(vmNameValue);
    if(!config)throw new Error('VirtualBox inspection requires the explicit resource configuration.');
    const executable=config.tools.vboxManagePath;
    const result=await this.command(executable,['showvminfo',parsedName,'--machinereadable'],15_000,true);
    if(result.exitCode!==0){
      if(/could not find a registered machine|VBOX_E_OBJECT_NOT_FOUND/i.test(result.stderr))return {exists:false,powerState:'unknown',uuid:null,nics:Array(8).fill(null),forwardingRules:[],sharedFolderCount:0,hostIntegrationsDisabled:false};
      throw new Error(this.safeCommandError(result));
    }
    const field=(name:string)=>new RegExp(`^${name}="([^"]*)"\\r?$`,'m').exec(result.stdout)?.[1]??null;
    const rawState=field('VMState');
    const powerState=rawState==='poweroff'||rawState==='running'||rawState==='saved'||rawState==='aborted'?rawState:'unknown';
    const lines=result.stdout.split(/\r?\n/);
    const forwardingRules=lines.flatMap(line=>{const match=/^Forwarding\(\d+\)="([^"]*)"$/.exec(line);return match?[match[1]!]:[];});
    const sharedFolderCount=lines.filter(line=>/^SharedFolderNameMachineMapping\d+=/i.test(line)||/^SharedFolderPathMachineMapping\d+=/i.test(line)).length;
    const nics=Array.from({length:8},(_,index)=>field(`nic${index+1}`));
    const disabled=(name:string,expected:string)=>field(name)===expected;
    const audio=field('audio');
    const hostIntegrationsDisabled=disabled('clipboard','disabled')&&disabled('draganddrop','disabled')&&disabled('vrde','off')&&
      disabled('usb','off')&&(field('ehci')??field('usbehci'))==='off'&&(field('xhci')??field('usbxhci'))==='off'&&(field('recording_enabled')??field('recording'))==='off'&&disabled('clipboard_file_transfers','off')&&
      (audio==='none'||audio==='off')&&disabled('audio_in','off')&&disabled('audio_out','off');
    return VmHostObservationSchema.parse({exists:true,powerState,uuid:field('UUID'),nics,forwardingRules,sharedFolderCount,hostIntegrationsDisabled});
  }
  async clone(config:VmAccessConfig){
    await this.vbox(config,['clonevm',config.baseVmName,`--name=${config.vmName}`,`--basefolder=${config.storageRoot}`,'--mode=machine','--register'],10*60_000);
  }
  async configure(config:VmAccessConfig){
    if(config.profile==='bridge')await this.vbox(config,['modifyvm',config.vmName,'--nat-pf1','delete','vmaccess-ssh'],30_000,true);
    const networkArgs=config.profile==='offline'?['--nic1=none']:[
      '--nic1=nat','--nic-promisc1=deny',`--nat-pf1=vmaccess-ssh,tcp,127.0.0.1,${this.hostAccess(config).port},,22`,
    ];
    await this.vbox(config,['modifyvm',config.vmName,'--clipboard-mode=disabled','--clipboard-file-transfers=disabled','--drag-and-drop=disabled',
      '--audio-enabled=off','--audio-in=off','--audio-out=off','--usb=off','--usb-ehci=off','--usb-xhci=off','--vrde=off','--recording=off',...networkArgs]);
    for(let index=2;index<=8;index++)await this.vbox(config,['modifyvm',config.vmName,`--nic${index}=none`]);
  }
  async start(config:VmAccessConfig){await this.vbox(config,['startvm',config.vmName,'--type=headless'],60_000);}
  private endpoint(host:string,port:number){return port===22?host:`[${host}]:${port}`;}
  private fingerprint(line:string){
    const fields=line.trim().split(/\s+/);if(fields.length<3)throw new Error('Matched known-hosts record is malformed.');
    let bytes:Buffer;try{bytes=Buffer.from(fields[2]!,'base64');}catch{throw new Error('Matched known-hosts key is not valid base64.');}
    if(bytes.length===0)throw new Error('Matched known-hosts key is empty.');
    return `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/,'')}`;
  }
  private assertUniqueEndpointRecord(output:string,expected:string,label:string){
    const records=output.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
    if(records.length!==1)throw new Error(`${label} must have exactly one known-hosts record for the explicit endpoint.`);
    if(this.fingerprint(records[0]!)!==expected.replace(/=+$/,''))throw new Error(`${label} fingerprint does not match the explicit endpoint record.`);
  }
  private async assertHostFingerprint(config:VmAccessConfig){
    const access=this.hostAccess(config),endpoint=this.endpoint(access.host,access.port);
    const result=await this.command(config.tools.sshKeygenPath,['-F',endpoint,'-f',access.knownHostsFile],15_000,true);
    if(result.exitCode!==0&&result.stdout.trim()==='')throw new Error('No guest host-key record matched the explicit loopback endpoint.');
    this.assertUniqueEndpointRecord(result.stdout,access.expectedHostKeyFingerprint,'Guest host key');
  }
  async validate(config:VmAccessConfig):Promise<VmProbeResult>{
    const observation=await this.inspect(config.vmName,config);
    assertConfiguredVmHost(config,observation,true);
    if(config.profile==='offline')return {guestReady:null,networkProfile:'offline',hostIdentityVerified:null,targetIdentityVerified:null,targetReached:null,
      details:['VirtualBox reports all NICs disabled and host integrations disabled.','Guest readiness is unknown because the offline profile performs no guest probe.']};
    await this.assertHostFingerprint(config);
    const selfTest=await this.ssh(config,'/usr/local/bin/secmaint-self-test');
    if(!selfTest.stdout.includes('SECMAINT_SELF_TEST=PASS'))throw new Error('Guest self-test did not report PASS.');
    const details=['VirtualBox runtime and loopback-only SSH forwarding observed.','Guest self-test reported PASS.'];
    const bridge=config.bridge!;
    const endpoint=this.endpoint(bridge.targetHost,bridge.targetPort);
    const targetKeys=await this.ssh(config,`ssh-keygen -F ${endpoint} -f ${bridge.guestKnownHostsFile}`,true);
    if(targetKeys.exitCode!==0&&targetKeys.stdout.trim()==='')throw new Error('No dedicated-host key record matched the explicit endpoint.');
    this.assertUniqueEndpointRecord(targetKeys.stdout,bridge.expectedHostKeyFingerprint,'Dedicated host key');
    await this.ssh(config,`sudo -n /usr/local/sbin/secmaint-target replace ${bridge.targetHost} ${bridge.targetPort}`);
    const target=await this.ssh(config,`ssh -F none -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${bridge.guestKnownHostsFile} -o GlobalKnownHostsFile=none -o ForwardAgent=no -o ClearAllForwardings=yes -p ${bridge.targetPort} -i ${bridge.guestIdentityFile} ${bridge.targetUser}@${bridge.targetHost} true`);
    if(target.exitCode!==0)throw new Error('Dedicated-host SSH probe failed through the prepared bridge.');
    details.push('Dedicated-host identity matched the guest-only known-hosts reference.','Explicit target SSH probe succeeded through the guest egress allowlist.');
    return {guestReady:true,networkProfile:'bridge',hostIdentityVerified:true,targetIdentityVerified:true,targetReached:true,details};
  }
  async close(config:VmAccessConfig){
    const before=await this.inspect(config.vmName,config);if(!before.exists||before.powerState==='poweroff')return;
    if(config.profile==='offline')await this.vbox(config,['controlvm',config.vmName,'acpipowerbutton'],30_000);
    else await this.ssh(config,'sudo -n shutdown -h now',true);
    const deadline=Date.now()+60_000;
    while(Date.now()<deadline){const current=await this.inspect(config.vmName,config);if(current.powerState==='poweroff')return;await new Promise(resolve=>setTimeout(resolve,1000));}
    throw new Error('Owned guest did not reach poweroff after the clean shutdown request.');
  }

}

export class VmAccessService {
  private readonly files:KnowledgeFiles;
  private readonly adapter:VmAccessHostAdapter;
  constructor(readonly root:string,adapter?:VmAccessHostAdapter){this.files=new KnowledgeFiles(root);this.adapter=adapter??new VirtualBoxVmAccessHost(root);}
  private resourceDir(resourceId:string){return path.join(this.root,'artifacts','vm-access','resources',resourceId);}
  private stateFile(resourceId:string){return path.join(this.resourceDir(resourceId),'state.json');}
  private desiredHash(config:VmAccessConfig){return KnowledgeFiles.hash(JSON.stringify(config));}
  private safeError(error:unknown,config?:VmAccessConfig){
    let message=error instanceof Error?error.message:String(error);
    for(const value of [this.root,config?.storageRoot,config?.hostSsh?.identityFile,config?.hostSsh?.knownHostsFile,config?.bridge?.guestIdentityFile,config?.bridge?.guestKnownHostsFile]
      .filter((v):v is string=>Boolean(v)))message=message.replaceAll(value,'[configured path]');
    return EvidenceSanitizer.text(message,2000);
  }
  private async readState(resourceId:string):Promise<VmAccessState|null>{
    try{return VmAccessStateSchema.parse(JSON.parse(await fs.readFile(this.stateFile(resourceId),'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  private async writeState(state:VmAccessState){await fs.mkdir(this.resourceDir(state.resourceId),{recursive:true});await atomicWriteJson(this.stateFile(state.resourceId),state);}
  private assertOwner(state:VmAccessState,selector:VmAccessSelector){if(state.ownerId!==selector.ownerId)throw new Error('Resource ownership mismatch; select the owning task explicitly.');}
  private assertConfig(state:VmAccessState,config:VmAccessConfig){this.assertOwner(state,config);if(state.desiredHash!==this.desiredHash(config))throw new Error('Resource ID already has a different immutable VM access configuration.');}
  private assertBoundVm(state:VmAccessState,observation:VmHostObservation){
    if(!observation.exists)return;
    if(!state.vmUuid)throw new Error('Owned state has no persisted clone UUID; refusing to adopt the observed VM after an interrupted clone.');
    if(observation.uuid!==state.vmUuid)throw new Error('Observed VM UUID differs from the owned clone UUID; refusing to touch a replacement VM with the same name.');
  }
  private async requireState(raw:unknown){const selector=VmAccessSelectorSchema.parse(raw),state=await this.readState(selector.resourceId);if(!state)throw new Error('Owned VM access state does not exist; preview and prepare it first.');this.assertOwner(state,selector);return state;}
  private async withLock<T>(resourceId:string,action:()=>Promise<T>):Promise<T>{
    const dir=this.resourceDir(resourceId),lock=path.join(dir,'.operation-lock');await fs.mkdir(dir,{recursive:true});
    try{await fs.mkdir(lock);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Another VM access operation owns this resource lock; inspect before retrying.');throw error;}
    try{return await action();}finally{await fs.rmdir(lock).catch(()=>undefined);}
  }
  private async receipt(operation:'prepare'|'start'|'validate'|'close',state:VmAccessState,observation:VmHostObservation,extra:Record<string,unknown>={}){
    const relative=`artifacts/integration/vm-access/${state.resourceId}/${new Date().toISOString().replace(/[:.]/g,'-')}-${operation}-${randomUUID()}.json`;
    await this.files.writeJsonNew(relative,{version:1,operation,resourceId:state.resourceId,ownerId:state.ownerId,desiredHash:state.desiredHash,status:state.status,
      observation,recordedAt:new Date().toISOString(),credentialMaterialStored:false,...extra});return relative;
  }
  async preview(raw:unknown):Promise<VmAccessResult>{
    const {config}=VmAccessPreviewInputSchema.parse(raw),desiredHash=this.desiredHash(config),state=await this.readState(config.resourceId);
    if(state)this.assertConfig(state,config);
    const observation=await this.inspectWithConfig(config.vmName,config);
    if(!state&&observation.exists)throw new Error('A VM with the requested name already exists without owned CodexInfra state.');
    if(state)this.assertBoundVm(state,observation);
    return VmAccessResultSchema.parse({operation:'preview',resourceId:config.resourceId,status:state?.status??'ready-to-prepare',changed:false,reused:Boolean(state&&observation.exists),desiredHash,observation,state});
  }
  private async inspectWithConfig(name:string,config:VmAccessConfig){
    return VmHostObservationSchema.parse(await this.adapter.inspect(name,config));
  }
  async prepare(raw:unknown):Promise<VmAccessResult>{
    const {config}=VmAccessPrepareInputSchema.parse(raw);return this.withLock(config.resourceId,async()=>{
      const desiredHash=this.desiredHash(config),existing=await this.readState(config.resourceId);if(existing)this.assertConfig(existing,config);
      let observation=await this.inspectWithConfig(config.vmName,config);
      if(existing)this.assertBoundVm(existing,observation);
      if(existing&&observation.exists&&['prepared','running','validated','closed'].includes(existing.status))
        return VmAccessResultSchema.parse({operation:'prepare',resourceId:config.resourceId,status:existing.status,changed:false,reused:true,desiredHash,observation,state:existing});
      if(!existing&&observation.exists)throw new Error('Refusing to adopt or alter a pre-existing VM without owned state.');
      const base=await this.inspectWithConfig(config.baseVmName,config);if(!base.exists)throw new Error('Explicit base VM was not found.');if(base.powerState!=='poweroff')throw new Error('Explicit base VM must be powered off before cloning.');
      if(base.sharedFolderCount!==0||base.forwardingRules.length!==0)throw new Error('Explicit base VM must not contain inherited shared folders or forwarding rules.');
      const now=new Date().toISOString();let state:VmAccessState=existing??{version:1,resourceId:config.resourceId,ownerId:config.ownerId,desiredHash,config,vmUuid:null,status:'preparing',createdAt:now,updatedAt:now,lastOperation:'prepare',lastError:null};
      state={...state,status:'preparing',updatedAt:now,lastOperation:'prepare',lastError:null};await this.writeState(state);
      try{
        if(!observation.exists){await this.adapter.clone(config);observation=await this.inspectWithConfig(config.vmName,config);if(!observation.exists||!observation.uuid)throw new Error('Clone command returned without an observable VM UUID.');state={...state,vmUuid:observation.uuid,updatedAt:new Date().toISOString()};await this.writeState(state);}
        this.assertBoundVm(state,observation);
        await this.adapter.configure(config);observation=await this.inspectWithConfig(config.vmName,config);
        this.assertBoundVm(state,observation);
        assertConfiguredVmHost(config,observation);
        state={...state,status:'prepared',updatedAt:new Date().toISOString(),lastError:null};await this.writeState(state);
        const receiptPath=await this.receipt('prepare',state,observation,{baseVmName:config.baseVmName,basePreserved:true,profile:config.profile});
        return VmAccessResultSchema.parse({operation:'prepare',resourceId:config.resourceId,status:state.status,changed:true,reused:Boolean(existing),desiredHash,observation,state,receiptPath});
      }catch(error){state={...state,status:'failed',updatedAt:new Date().toISOString(),lastError:this.safeError(error,config)};await this.writeState(state);await this.receipt('prepare',state,observation,{error:state.lastError,resumable:true});throw error;}
    });
  }
  async inspect(raw:unknown):Promise<VmAccessResult>{
    const state=await this.requireState(raw),observation=await this.inspectWithConfig(state.config.vmName,state.config);
    this.assertBoundVm(state,observation);
    return VmAccessResultSchema.parse({operation:'inspect',resourceId:state.resourceId,status:state.status,changed:false,reused:true,desiredHash:state.desiredHash,observation,state});
  }
  async start(raw:unknown):Promise<VmAccessResult>{
    const selector=VmAccessStartInputSchema.parse(raw);return this.withLock(selector.resourceId,async()=>{
      let state=await this.requireState(selector),observation=await this.inspectWithConfig(state.config.vmName,state.config);
      this.assertBoundVm(state,observation);
      if(state.status==='failed')throw new Error('Failed VM state must be recovered by its failed lifecycle operation before start.');
      if(observation.powerState==='running'){
        const changed=state.status!=='running';if(changed){state={...state,status:'running',updatedAt:new Date().toISOString(),lastOperation:'start',lastError:null};await this.writeState(state);}
        return VmAccessResultSchema.parse({operation:'start',resourceId:state.resourceId,status:'running',changed,reused:true,desiredHash:state.desiredHash,observation,state});
      }
      if(!observation.exists)throw new Error('Owned VM is missing; inspect the failed resource before preparing again.');
      if(!['prepared','closed'].includes(state.status))throw new Error(`VM cannot start from lifecycle state ${state.status}.`);
      assertConfiguredVmHost(state.config,observation);
      try{await this.adapter.start(state.config);observation=await this.inspectWithConfig(state.config.vmName,state.config);if(observation.powerState!=='running')throw new Error('Start command returned without an observed running VM.');
        state={...state,status:'running',updatedAt:new Date().toISOString(),lastOperation:'start',lastError:null};await this.writeState(state);const receiptPath=await this.receipt('start',state,observation);
        return VmAccessResultSchema.parse({operation:'start',resourceId:state.resourceId,status:state.status,changed:true,reused:false,desiredHash:state.desiredHash,observation,state,receiptPath});
      }catch(error){state={...state,status:'failed',updatedAt:new Date().toISOString(),lastOperation:'start',lastError:this.safeError(error,state.config)};await this.writeState(state);await this.receipt('start',state,observation,{error:state.lastError,resumable:true});throw error;}
    });
  }
  async validate(raw:unknown):Promise<VmAccessResult>{
    const selector=VmAccessValidateInputSchema.parse(raw);return this.withLock(selector.resourceId,async()=>{
      let state=await this.requireState(selector),observation=await this.inspectWithConfig(state.config.vmName,state.config);if(observation.powerState!=='running')throw new Error('Validation requires the owned VM to be observed running.');
      this.assertBoundVm(state,observation);
      try{const probe=VmProbeResultSchema.parse(await this.adapter.validate(state.config));if(state.config.profile==='bridge'&&probe.guestReady!==true)throw new Error('Guest probe did not establish readiness.');
        if(state.config.profile==='offline'&&probe.guestReady!==null)throw new Error('Offline validation must leave guest readiness explicitly unknown.');
        state={...state,status:'validated',updatedAt:new Date().toISOString(),lastOperation:'validate',lastError:null};await this.writeState(state);observation=await this.inspectWithConfig(state.config.vmName,state.config);const receiptPath=await this.receipt('validate',state,observation,{probe});
        return VmAccessResultSchema.parse({operation:'validate',resourceId:state.resourceId,status:state.status,changed:true,reused:false,desiredHash:state.desiredHash,observation,state,probe,receiptPath});
      }catch(error){state={...state,status:'failed',updatedAt:new Date().toISOString(),lastOperation:'validate',lastError:this.safeError(error,state.config)};await this.writeState(state);await this.receipt('validate',state,observation,{error:state.lastError,resumable:true});throw error;}
    });
  }
  async close(raw:unknown):Promise<VmAccessResult>{
    const selector=VmAccessCloseInputSchema.parse(raw);return this.withLock(selector.resourceId,async()=>{
      let state=await this.requireState(selector),observation=await this.inspectWithConfig(state.config.vmName,state.config);
      this.assertBoundVm(state,observation);
      if(observation.powerState==='poweroff'&&state.status==='closed')return VmAccessResultSchema.parse({operation:'close',resourceId:state.resourceId,status:'closed',changed:false,reused:true,desiredHash:state.desiredHash,observation,state});
      if(!observation.exists)throw new Error('Owned VM is missing; close will not target another resource.');
      try{if(observation.powerState!=='poweroff')await this.adapter.close(state.config);observation=await this.inspectWithConfig(state.config.vmName,state.config);if(observation.powerState!=='poweroff')throw new Error('Close did not confirm poweroff for the owned VM.');
        state={...state,status:'closed',updatedAt:new Date().toISOString(),lastOperation:'close',lastError:null};await this.writeState(state);const receiptPath=await this.receipt('close',state,observation,{resourcePreserved:true,deleted:false});
        return VmAccessResultSchema.parse({operation:'close',resourceId:state.resourceId,status:state.status,changed:true,reused:false,desiredHash:state.desiredHash,observation,state,receiptPath});
      }catch(error){state={...state,status:'failed',updatedAt:new Date().toISOString(),lastOperation:'close',lastError:this.safeError(error,state.config)};await this.writeState(state);await this.receipt('close',state,observation,{error:state.lastError,resumable:true});throw error;}
    });
  }
  async sessionCommand(raw:unknown):Promise<VmAccessSessionCommand>{
    const selector=VmAccessSessionInputSchema.parse(raw),state=await this.requireState(selector),observation=await this.inspectWithConfig(state.config.vmName,state.config);
    this.assertBoundVm(state,observation);
    if(state.status!=='validated'||state.config.profile!=='bridge'||observation.powerState!=='running')throw new Error('Interactive bridge session requires this owned VM to be currently running and validated.');
    assertConfiguredVmHost(state.config,observation,true);
    return buildVmAccessBridgeSessionCommand(state.config);
  }
}
