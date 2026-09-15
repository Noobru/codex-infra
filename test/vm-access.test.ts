import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {VirtualBoxVmAccessHost,VmAccessConfigSchema,VmAccessService,type VmAccessConfig,type VmAccessHostAdapter,type VmHostObservation,type VmProbeResult} from '../src/vm-access.js';

const emptyObservation=():VmHostObservation=>({exists:false,powerState:'unknown',uuid:null,nics:Array(8).fill(null),forwardingRules:[],sharedFolderCount:0,hostIntegrationsDisabled:false});
const baseObservation=():VmHostObservation=>({exists:true,powerState:'poweroff',uuid:'base-uuid',nics:Array(8).fill('none'),forwardingRules:[],sharedFolderCount:0,hostIntegrationsDisabled:true});
const fingerprint=(key:Buffer)=>`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`;
const hostKey=Buffer.from('fixture-host-public-key'),targetKey=Buffer.from('fixture-target-public-key');

class FakeHost implements VmAccessHostAdapter {
  readonly vms=new Map<string,VmHostObservation>([['prepared-base',baseObservation()]]);
  clones=0;configures=0;starts=0;validates=0;closes=0;failConfigure=false;failValidation=false;failCloneAfterCreate=false;
  async inspect(name:string,_config?:VmAccessConfig):Promise<VmHostObservation>{return structuredClone(this.vms.get(name)??emptyObservation());}
  async clone(config:VmAccessConfig){this.clones++;this.vms.set(config.vmName,{...baseObservation(),uuid:`uuid-${config.resourceId}`,hostIntegrationsDisabled:false});if(this.failCloneAfterCreate)throw new Error('fixture clone interrupted');}
  async configure(config:VmAccessConfig){this.configures++;if(this.failConfigure)throw new Error('fixture configuration failed');const vm=this.vms.get(config.vmName)!;vm.nics=[config.profile==='offline'?'none':'nat',...Array(7).fill('none')];vm.forwardingRules=config.profile==='bridge'?[`vmaccess-ssh,tcp,127.0.0.1,${config.hostSsh!.port},,22`]:[];vm.sharedFolderCount=0;vm.hostIntegrationsDisabled=true;}
  async start(config:VmAccessConfig){this.starts++;this.vms.get(config.vmName)!.powerState='running';}
  async validate(config:VmAccessConfig):Promise<VmProbeResult>{this.validates++;if(this.failValidation)throw new Error('fixture probe failed');return {guestReady:config.profile==='offline'?null:true,networkProfile:config.profile,hostIdentityVerified:config.profile==='offline'?null:true,targetIdentityVerified:config.profile==='bridge'?true:null,targetReached:config.profile==='bridge'?true:null,details:['fixture probe']};}
  async close(config:VmAccessConfig){this.closes++;this.vms.get(config.vmName)!.powerState='poweroff';}
}

async function fixture(t:import('node:test').TestContext,profile:'offline'|'bridge'='offline'){
  const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'vm-access-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(parent)+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const host=new FakeHost();
  const config=VmAccessConfigSchema.parse({resourceId:'audit-fixture',ownerId:'job-fixture',baseVmName:'prepared-base',vmName:'audit-clone',profile,
    storageRoot:path.join(root,'vms'),tools:{vboxManagePath:path.join(root,'tools','VBoxManage.exe'),sshPath:path.join(root,'tools','ssh.exe'),sshKeygenPath:path.join(root,'tools','ssh-keygen.exe')},
    ...(profile==='bridge'?{hostSsh:{host:'127.0.0.1',port:22222,user:'secmaint',identityFile:path.join(root,'host-key'),knownHostsFile:path.join(root,'known_hosts'),expectedHostKeyFingerprint:fingerprint(hostKey)},
      bridge:{targetHost:'192.0.2.10',targetPort:22,targetUser:'operator',guestIdentityFile:'/var/lib/secmaint/.ssh/dedicated_ed25519',guestKnownHostsFile:'/var/lib/secmaint/.ssh/dedicated_known_hosts',expectedHostKeyFingerprint:fingerprint(targetKey)}}:{}),
  });
  return {root,host,config,service:new VmAccessService(root,host),selector:{resourceId:config.resourceId,ownerId:config.ownerId}};
}

test('offline lifecycle has no NIC, reports guest readiness unknown, and preserves the base',async t=>{
  const {root,host,config,service,selector}=await fixture(t);
  assert.equal((await service.preview({config})).status,'ready-to-prepare');
  const prepared=await service.prepare({config});assert.equal(prepared.status,'prepared');assert.equal(prepared.state?.vmUuid,'uuid-audit-fixture');
  const repeated=await service.prepare({config});assert.equal(repeated.reused,true);assert.equal(host.clones,1);assert.equal(host.configures,1);
  assert.equal((await host.inspect(config.baseVmName)).uuid,'base-uuid');
  await service.start(selector);const validated=await service.validate(selector);assert.equal(validated.probe?.guestReady,null);assert.equal(validated.probe?.hostIdentityVerified,null);
  assert.equal((await service.close(selector)).status,'closed');assert.equal(host.closes,1);assert.equal((await service.close(selector)).reused,true);
  const receipts=await fs.readdir(path.join(root,'artifacts/integration/vm-access',config.resourceId));assert.equal(receipts.length,4);
  assert.doesNotMatch(await fs.readFile(path.join(root,'artifacts/integration/vm-access',config.resourceId,receipts[0]!),'utf8'),/host-key|known_hosts|dedicated_ed25519/);
});

test('ownership, immutable configuration, and unowned names fail before mutation',async t=>{
  const {host,config,service,selector}=await fixture(t);await service.prepare({config});
  await assert.rejects(service.inspect({...selector,ownerId:'another-job'}),/ownership mismatch/i);
  await assert.rejects(service.prepare({config:{...config,storageRoot:path.join(config.storageRoot,'other')}}),/different immutable/i);
  const other=await fixture(t);other.host.vms.set(other.config.vmName,{...baseObservation(),uuid:'foreign'});
  await assert.rejects(other.service.preview({config:other.config}),/without owned/i);await assert.rejects(other.service.prepare({config:other.config}),/pre-existing/i);
  assert.equal(other.host.clones,0);assert.equal(other.host.configures,0);assert.equal(host.clones,1);
});

test('persisted clone UUID permits recovery but rejects interrupted adoption and same-name replacement',async t=>{
  const recoverable=await fixture(t);recoverable.host.failConfigure=true;await assert.rejects(recoverable.service.prepare({config:recoverable.config}),/fixture configuration failed/);
  recoverable.host.failConfigure=false;assert.equal((await recoverable.service.prepare({config:recoverable.config})).status,'prepared');assert.equal(recoverable.host.clones,1);
  const interrupted=await fixture(t);interrupted.host.failCloneAfterCreate=true;await assert.rejects(interrupted.service.prepare({config:interrupted.config}),/clone interrupted/);interrupted.host.failCloneAfterCreate=false;
  await assert.rejects(interrupted.service.prepare({config:interrupted.config}),/no persisted clone UUID/i);assert.equal(interrupted.host.configures,0);
  const replaced=await fixture(t);await replaced.service.prepare({config:replaced.config});replaced.host.vms.get(replaced.config.vmName)!.uuid='replacement';
  await assert.rejects(replaced.service.start(replaced.selector),/differs from the owned clone UUID/i);assert.equal(replaced.host.starts,0);
  await assert.rejects(replaced.service.close(replaced.selector),/differs from the owned clone UUID/i);assert.equal(replaced.host.closes,0);
});

test('bases with shared folders or inherited forwards are rejected',async t=>{
  const shared=await fixture(t);shared.host.vms.get(shared.config.baseVmName)!.sharedFolderCount=1;
  await assert.rejects(shared.service.prepare({config:shared.config}),/shared folders or forwarding/i);assert.equal(shared.host.clones,0);
  const forwarded=await fixture(t);forwarded.host.vms.get(forwarded.config.baseVmName)!.forwardingRules=['legacy,tcp,127.0.0.1,1,,1'];
  await assert.rejects(forwarded.service.prepare({config:forwarded.config}),/shared folders or forwarding/i);assert.equal(forwarded.host.clones,0);
});

test('failed state cannot start and running does not retain stale validation',async t=>{
  const failed=await fixture(t);failed.host.failConfigure=true;await assert.rejects(failed.service.prepare({config:failed.config}));
  await assert.rejects(failed.service.start(failed.selector),/failed VM state/i);assert.equal(failed.host.starts,0);
  const current=await fixture(t,'bridge');await current.service.prepare({config:current.config});await current.service.start(current.selector);await current.service.validate(current.selector);
  const restarted=await current.service.start(current.selector);assert.equal(restarted.status,'running');assert.equal(restarted.state?.status,'running');assert.equal(restarted.probe,undefined);
  await current.service.close(current.selector);current.host.vms.get(current.config.vmName)!.nics[7]='nat';
  await assert.rejects(current.service.start(current.selector),/isolated NIC configuration/i);assert.equal(current.host.starts,1);
});

test('schemas separate a NIC-less offline profile from an explicit bridge',async t=>{
  const {config}=await fixture(t);assert.throws(()=>VmAccessConfigSchema.parse({...config,hostSsh:{host:'127.0.0.1'}}));assert.throws(()=>VmAccessConfigSchema.parse({...config,profile:'bridge'}));assert.throws(()=>VmAccessConfigSchema.parse({...config,baseVmName:config.vmName}));
});

test('VirtualBox parser handles CRLF and configuration disables all extra NICs',async t=>{
  const {root,config}=await fixture(t,'bridge');const calls:Array<{executable:string;args:string[]}>=[];
  const info=['VMState="poweroff"','UUID="clone-uuid"','nic1="nat"',...Array.from({length:7},(_,i)=>`nic${i+2}="none"`),'clipboard="disabled"','draganddrop="disabled"','vrde="off"','usb="off"','ehci="off"','xhci="off"','recording_enabled="off"','clipboard_file_transfers="off"','audio="none"','audio_in="off"','audio_out="off"',`Forwarding(0)="vmaccess-ssh,tcp,127.0.0.1,${config.hostSsh!.port},,22"`].join('\r\n')+'\r\n';
  const runner={async run(executable:string,args:string[],cwd:string){calls.push({executable,args});return {executable,args,cwd,exitCode:0,stdout:args[0]==='showvminfo'?info:'',stderr:'',durationMs:1};}};
  const adapter=new VirtualBoxVmAccessHost(root,runner);const observed=await adapter.inspect(config.vmName,config);assert.equal(observed.uuid,'clone-uuid');assert.equal(observed.nics[7],'none');assert.equal(observed.hostIntegrationsDisabled,true);
  await adapter.configure(config);assert.ok(calls.some(call=>call.args.includes('--nic8=none')));assert.ok(calls.some(call=>call.args.includes(`--nat-pf1=vmaccess-ssh,tcp,127.0.0.1,${config.hostSsh!.port},,22`)));
  const offline=(await fixture(t)).config;calls.length=0;await adapter.configure(offline);assert.ok(calls.some(call=>call.args.includes('--nic1=none')));assert.ok(calls.every(call=>!call.args.some(arg=>arg.startsWith('--nat-pf1='))));
});

test('fingerprints bind one exact endpoint and SSH ignores ambient config and global hosts',async t=>{
  const {root,config}=await fixture(t,'bridge');const calls:Array<{executable:string;args:string[]}>=[];
  const runningInfo=['VMState="running"','UUID="clone-uuid"','nic1="nat"',...Array.from({length:7},(_,i)=>`nic${i+2}="none"`),'clipboard="disabled"','draganddrop="disabled"','vrde="off"','usb="off"','ehci="off"','xhci="off"','recording_enabled="off"','clipboard_file_transfers="off"','audio="none"','audio_in="off"','audio_out="off"',`Forwarding(0)="vmaccess-ssh,tcp,127.0.0.1,${config.hostSsh!.port},,22"`].join('\r\n')+'\r\n';
  const runner={async run(executable:string,args:string[],cwd:string){calls.push({executable,args});let stdout='';
    if(executable===config.tools.vboxManagePath)stdout=runningInfo;
    else if(executable===config.tools.sshKeygenPath)stdout=`# Host [127.0.0.1]:22222 found: line 1\n[127.0.0.1]:22222 ssh-ed25519 ${hostKey.toString('base64')}\n`;
    else {const remote=args.at(-1)??'';if(remote.includes('secmaint-self-test'))stdout='SECMAINT_SELF_TEST=PASS\n';else if(remote.startsWith('ssh-keygen -F'))stdout=`# Host 192.0.2.10 found: line 1\n192.0.2.10 ssh-ed25519 ${targetKey.toString('base64')}\n`;}
    return {executable,args,cwd,exitCode:0,stdout,stderr:'',durationMs:1};}};
  const result=await new VirtualBoxVmAccessHost(root,runner).validate(config);assert.equal(result.targetReached,true);
  assert.deepEqual(calls.find(call=>call.executable===config.tools.sshKeygenPath)!.args.slice(0,2),['-F','[127.0.0.1]:22222']);
  for(const call of calls.filter(call=>call.executable===config.tools.sshPath)){assert.ok(call.args.includes('-F'));assert.ok(call.args.includes('GlobalKnownHostsFile=none'));}
  const inner=calls.filter(call=>call.executable===config.tools.sshPath).map(call=>call.args.at(-1)).find(value=>value?.startsWith('ssh -F none'))!;assert.match(inner,/GlobalKnownHostsFile=none/);assert.match(inner,/StrictHostKeyChecking=yes/);
  const duplicate={async run(executable:string,args:string[],cwd:string){let stdout=runningInfo;if(executable===config.tools.sshKeygenPath)stdout=`[127.0.0.1]:22222 ssh-ed25519 ${hostKey.toString('base64')}\n[127.0.0.1]:22222 ssh-rsa ${targetKey.toString('base64')}\n`;return {executable,args,cwd,exitCode:0,stdout,stderr:'',durationMs:1};}};
  await assert.rejects(new VirtualBoxVmAccessHost(root,duplicate).validate(config),/exactly one known-hosts record/i);
});

test('interactive bridge command is available only after current validation',async t=>{
  const {service,config,selector}=await fixture(t,'bridge');await service.prepare({config});await service.start(selector);await assert.rejects(service.sessionCommand(selector),/currently running and validated/i);await service.validate(selector);
  const command=await service.sessionCommand(selector);assert.equal(command.executable,config.tools.sshPath);assert.ok(command.args.includes('-tt'));assert.ok(command.args.includes('GlobalKnownHostsFile=none'));
  const inner=command.args.at(-1)!;assert.match(inner,/^exec ssh -F none /);assert.match(inner,/StrictHostKeyChecking=yes/);assert.match(inner,/GlobalKnownHostsFile=none/);assert.doesNotMatch(inner,/ true$/);
});

test('offline close uses VirtualBox ACPI and polls without guest SSH',async t=>{
  const {root,config}=await fixture(t);let running=true;const calls:Array<{executable:string;args:string[]}>=[];
  const info=()=>[`VMState="${running?'running':'poweroff'}"`,'UUID="clone-uuid"','nic1="none"',...Array.from({length:7},(_,i)=>`nic${i+2}="none"`),'clipboard="disabled"','draganddrop="disabled"','vrde="off"','usb="off"','ehci="off"','xhci="off"','recording_enabled="off"','clipboard_file_transfers="off"','audio="none"','audio_in="off"','audio_out="off"'].join('\n');
  const runner={async run(executable:string,args:string[],cwd:string){calls.push({executable,args});if(args[0]==='controlvm')running=false;return {executable,args,cwd,exitCode:0,stdout:args[0]==='showvminfo'?info():'',stderr:'',durationMs:1};}};
  await new VirtualBoxVmAccessHost(root,runner).close(config);assert.ok(calls.some(call=>call.args[0]==='controlvm'&&call.args[2]==='acpipowerbutton'));assert.ok(calls.every(call=>call.executable!==config.tools.sshPath));
});
