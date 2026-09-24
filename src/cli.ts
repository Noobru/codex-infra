#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskEngine } from './engine.js';
import {WorkCoordinator} from './work-coordinator.js';
import { AppServerClient } from './app-server.js';
import { RecoveryManager } from './recovery.js';
import { HealthInspector } from './health.js';
import { QueueCoordinator } from './queue.js';
import { SupervisorManager } from './supervisor.js';
import { readJson, atomicWriteJson } from './legacy/command-os-utils.js';
import { ModelCatalog } from './model-catalog.js';
import { RoutingConfigurationStore } from './routing-configuration.js';
import { ObservationServer } from './observation-server.js';
import { SecurityIntegrationFacade } from './security-integration.js';
import {WorkflowManager} from './workflow.js';
import {KnowledgeIndex} from './knowledge-index.js';
import {KnowledgeLearningStore} from './knowledge-learning.js';
import { EvaluationStore } from './evaluation.js';
import { InteractionEntry } from './interaction-entry.js';
import { InteractionStore } from './interactions.js';
import { GIdeiaBootstrap } from './g-ideia-bootstrap.js';
import { OperationalInsights } from './operational-insights.js';
import { EfficiencyHistory,EfficiencyHistoryInputSchema } from './efficiency-history.js';
import { InteractionTelemetry } from './interaction-telemetry.js';
import { ImprovementImpactReader } from './improvement-impact.js';
import { LearningApplications } from './learning-applications.js';
import { AutonomousLearning } from './autonomous-learning.js';
import { LearningRuntimeStore, LearningActivationPolicySchema } from './learning-runtime.js';
import { LearningSandbox } from './learning-sandbox.js';
import { DelegationLifecycle } from './delegation-lifecycle.js';
import { DockerRecovery } from './docker-recovery.js';
import { VmAccessService } from './vm-access.js';

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {values, positionals} = parseArgs({allowPositionals: true, options: {
  root: {type:'string'}, project: {type:'string'}, objective: {type:'string'}, key: {type:'string'},
  mode: {type:'string',default:'read-only'}, kind: {type:'string',default:'checks'},
  checks: {type:'string'}, timeout: {type:'string',default:'300000'}, target: {type:'string'}, snapshot: {type:'string'},
  depends: {type:'string'}, 'max-jobs': {type:'string'}, requirements: {type:'string'}, 'root-overrides': {type:'string'},
  workspace: {type:'string',default:'in-place'}, 'base-ref': {type:'string'},
  file: {type:'string'}, replace: {type:'boolean',default:false}, 'fresh-thread': {type:'boolean',default:false}, evidence: {type:'string'},
  port:{type:'string',default:'4317'}, projects:{type:'string'},
  concurrency:{type:'string'}, jobs:{type:'string'}, apply:{type:'boolean',default:false},
  days:{type:'string'}, 'continue-independent':{type:'boolean',default:false},
}});
const root = path.resolve(values.root ?? process.env.CODEX_INFRA_ROOT ?? defaultRoot);
const command = positionals[0] ?? 'help';
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
let engine: TaskEngine | undefined;
try {
  if (command === 'help') print({commands: ['vm-access preview|prepare|inspect|start|validate|close|reconcile-cleanup|session-command --file INPUT.json','delivery JOB_ID','finish-delegation JOB_ID --file DECISION.json','learning-recover CASE_ID --file DECISION.json','efficiency-history [--project ID] [--days 7|14|30|90]','telemetry-capture THREAD_UUID','telemetry-reconcile [--max-jobs 1..10]','telemetry-read [--project ID] [--days N]','learning-application --file INPUT.json','learning-effects CANDIDATE_ID','bootstrap-g-ideia --file INPUT.json [--apply]','enter-interaction --file INPUT.json','record-interaction ID --file UPDATE.json','interactions [ID] [--file FILTERS.json]','interactions-import --file INVENTORY.json','interaction-findings ID','insights-reconcile [--project ID] [--max-jobs N]','doctor [--project ID]','projects','register --file PROFILE.json [--replace]','context --project ID','models','route --file ROUTING.json','delegate --file DELEGATION.json','task-context --file TASK.json','prepare --file TASK.json','prepare --project ID --objective TEXT --key KEY --kind checks --checks id,id [--depends ID,ID] [--requirements IG-01] [--workspace worktree --base-ref REF]','execution-policy [--file POLICY.json]','workflow-prepare --file WORKFLOW.json','workflow-status WORKFLOW_ID','workflow-run WORKFLOW_ID [--concurrency N] [--timeout MILLISECONDS]','workflow-start WORKFLOW_ID [--concurrency N] [--timeout MILLISECONDS]','workflow-cancel WORKFLOW_ID','workflow-replan WORKFLOW_ID --file REPLAN.json','knowledge-index --project ID','knowledge-search --file SEARCH.json','learning-list [--project ID]','learning-read CANDIDATE_ID','learning-propose --file PROPOSAL.json','learning-review CANDIDATE_ID --file REVIEW.json','learning-shadow-source CANDIDATE_ID','learning-shadow CANDIDATE_ID --file SHADOW.json','learning-promote CANDIDATE_ID --file DECISION.json','learning-revert CANDIDATE_ID --file DECISION.json','security-report --project ID --file GATE-INPUT.json','evaluation-record --file EVALUATION.json','evaluation EVALUATION_ID','evaluation-compare --file COMPARISON.json','observe [--port 4317] [--timeout MILLISECONDS (1000-7200000; default 300000)]','run JOB_ID','drain --max-jobs N --timeout MILLISECONDS [--concurrency N] [--jobs ID,ID]','start-queue --max-jobs N --timeout MILLISECONDS [--concurrency N] [--jobs ID,ID]','queue-status SUPERVISOR_ID','stop-queue SUPERVISOR_ID','status [JOB_ID]','events JOB_ID','cancel JOB_ID','retry JOB_ID [--fresh-thread]','confirm-stopped JOB_ID --evidence TEXT','reconcile','probe','snapshot --target DIR','restore --snapshot DIR --target NEW_DIR','activate-restore [--projects id,id] [--root-overrides FILE.json]'],root});
  else if (command === 'vm-access') {
    const action=positionals[1];
    if (!values.file) throw new Error('--file INPUT.json is required');
    const service=new VmAccessService(root),input=await readJson(values.file,null);
    switch(action) {
      case 'preview': print(await service.preview(input));break;
      case 'prepare': print(await service.prepare(input));break;
      case 'inspect': print(await service.inspect(input));break;
      case 'start': print(await service.start(input));break;
      case 'validate': print(await service.validate(input));break;
      case 'close': print(await service.close(input));break;
      case 'reconcile-cleanup': print(await service.reconcileCleanup(input));break;
      case 'session-command': print(await service.sessionCommand(input));break;
      default: throw new Error('Use vm-access preview|prepare|inspect|start|validate|close|reconcile-cleanup|session-command --file INPUT.json');
    }
  }
  else if (command === 'docker-recovery') {
    const recovery=new DockerRecovery(root);
    print(values.file?await recovery.recover(await readJson(values.file,null)):await recovery.inspect());
  }
  else if (command === 'bootstrap-g-ideia') {
    if (!values.file) throw new Error('--file bootstrap.local.json is required');
    const bootstrap = new GIdeiaBootstrap(root), input = await readJson(values.file, null);
    print(values.apply ? await bootstrap.apply(input) : await bootstrap.plan(input));
  }
  else if (command === 'learning-policy') {
    if(values.file) {
      const policy=LearningActivationPolicySchema.parse(await readJson(values.file,null));
      await atomicWriteJson(path.join(root,'profiles/learning-policy.json'),policy);
      print({configured:true,enabled:policy.enabled,automaticActivation:policy.automaticActivation,allowedProjectIds:policy.allowedProjectIds});
    } else print(await LearningRuntimeStore.readPolicy(root));
  }
  else if (command === 'learning-cycle') print(await new AutonomousLearning(root).list(values.project));
  else if (command === 'finish-delegation') {
    if(!values.file)throw new Error('--file integration decision is required');
    print(await new DelegationLifecycle(root).finish(positionals[1]??'',await readJson(values.file,null)));
  }
  else if (command === 'learning-recover') {
    if (!values.file) throw new Error('--file recovery decision is required');
    print(await new AutonomousLearning(root).recover(positionals[1]??'', await readJson(values.file,null)));
  }
  else if (command === 'learning-reconcile') print(await new AutonomousLearning(root).onEvent(values.project));
  else if (command === 'learning-drain') print(await new AutonomousLearning(root).drain({maxJobs:Number(values['max-jobs']??1),totalTimeoutMs:Number(values.timeout)}));
  else if (command === 'capabilities') print(await new LearningRuntimeStore(root).list(values.project));
  else if (command === 'capability-run' || command === 'capability-disable') {
    if(!values.file)throw new Error('--file input.json is required');
    const runtime = new LearningRuntimeStore(root,new LearningSandbox(root)), input = await readJson(values.file,null), hash = positionals[1]??'';
    print(command === 'capability-run' ? await runtime.run(hash,input) : await runtime.disable(hash,input));
  }
  else if (command === 'insights-reconcile') {
    print(await new OperationalInsights(root).reconcile({projectId:values.project,limit:values['max-jobs']===undefined?undefined:Number(values['max-jobs'])}));
  }
  else if (command === 'interaction-findings') print(await new InteractionEntry(root).reconcileFindings(positionals[1]??''));
  else if (command === 'efficiency-history') {
    const input=EfficiencyHistoryInputSchema.parse({projectId:values.project,days:values.days===undefined?undefined:Number(values.days)});
    const history=await new EfficiencyHistory(root).history(input);
    print({history,improvements:await new ImprovementImpactReader(root).read(history,values.project)});
  }
  else if (command === 'telemetry-capture') print(await new InteractionTelemetry(root).capture(positionals[1]??''));
  else if (command === 'telemetry-reconcile') print(await new InteractionTelemetry(root).reconcile({limit:values['max-jobs']===undefined?undefined:Number(values['max-jobs'])}));
  else if (command === 'telemetry-read') print(await new InteractionTelemetry(root).read({projectId:values.project,days:values.days===undefined?undefined:Number(values.days)}));
  else if (command === 'learning-application') {
    if(!values.file)throw new Error('--file application.json is required');
    print(await new LearningApplications(root).record(await readJson(values.file,null)));
  }
  else if (command === 'learning-effects') print(await new LearningApplications(root).getEffects(positionals[1]??''));
  else if (['enter-interaction','record-interaction','interactions-import','interactions'].includes(command)) {
    if (!values.file && command !== 'interactions') throw new Error('--file input.json is required');
    const input = values.file ? await readJson(values.file, null) : {};
    if (command === 'enter-interaction') print(await new InteractionEntry(root).enter(input));
    else if (command === 'record-interaction') print(await new InteractionEntry(root).record(positionals[1] ?? '', input));
    else if (command === 'interactions-import') print(await new InteractionStore(root).importThreads(input));
    else print(positionals[1] ? await new InteractionStore(root).read(positionals[1]) : await new InteractionStore(root).list(input));
  }
  else if (command === 'doctor') { const report = await new HealthInspector(root).inspect(values.project); print(report); if (!report.ok) process.exitCode = 2; }
  else if (command === 'activate-restore') {
    const overrides = values['root-overrides'] ? await readJson(values['root-overrides'],null) : {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.values(overrides).some(value=>typeof value !== 'string')) throw new Error('Root overrides must be a JSON object mapping project IDs to absolute paths');
    print(await new RecoveryManager(root).activate(overrides,values.projects?.split(',')));
  }
  else if(command==='observe'){
    const server=new ObservationServer(root);
    try {print(await server.start(Number(values.port)));
      const duration=Number(values.timeout);
      if(!Number.isFinite(duration)||duration<1000||duration>7200000)throw new Error('Observation timeout must be 1000–7200000 ms');
      await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);process.off('SIGINT',done);process.off('SIGTERM',done);resolve();};const timer=setTimeout(done,duration);process.once('SIGINT',done);process.once('SIGTERM',done);});
    }finally{await server.close();}
  }
  else if (command === 'models') {
    const client=new AppServerClient({cwd:root});
    try {await client.connect();print(await new ModelCatalog().read(client));}finally{await client.close();}
  }
  else if (command === 'route') {
    if(!values.file)throw new Error('--file routing.json is required');
    print((await new RoutingConfigurationStore(root).read()).decide(await readJson(values.file,null)));
  }
  else if(command==='evaluation-record'||command==='evaluation-compare'){
    if(!values.file)throw new Error('--file input.json is required');
    const input=await readJson(values.file,null), evaluations=new EvaluationStore(root);
    print(command==='evaluation-record'?await evaluations.record(input):await evaluations.compare(input));
  }
  else if(command==='evaluation')print(await new EvaluationStore(root).read(positionals[1]??''));
  else if (command === 'probe') {
    const client = new AppServerClient({cwd: root});
    try { print(await client.probeAccount()); } finally { await client.close(); }
  } else if (command === 'snapshot' || command === 'restore') {
    if (!values.target) throw new Error('--target is required');
    const recovery = new RecoveryManager(root);
    if (command === 'snapshot') print(await recovery.snapshot(values.target));
    else {if (!values.snapshot) throw new Error('--snapshot is required'); print(await recovery.restore(values.snapshot, values.target));}
  } else {
    engine = new TaskEngine(root);
    const id = positionals[1] ?? '';
    switch (command) {
      case 'work-prepare': case 'work-run': case 'work-direct': case 'work-status': {
        if(!values.file)throw new Error('--file work-unit.json is required');
        const work=new WorkCoordinator(engine),input=await readJson(values.file,null);
        print(command==='work-prepare'?await work.prepare(input):command==='work-run'?await work.run(input):command==='work-direct'?await work.recordDirect(input):await work.status(input));break;
      }
      case 'work-summary': print(await new WorkCoordinator(engine).summary(id));break;
      case 'execution-policy': print(values.file?await engine.execution.configure(await readJson(values.file,null)):await engine.execution.read());break;
      case 'delegate':
        if (!values.file) throw new Error('--file qualified-task.json is required; the orchestrator supplies qualification');
        { const result = await engine.delegate(await readJson(values.file, null)); print(result); if (!result.supervisor && result.job.status !== 'completed') process.exitCode = 2; }
        break;
      case 'workflow-prepare': {
        if(!values.file)throw new Error('--file workflow.json is required');
        print(await new WorkflowManager(engine).prepare(await readJson(values.file,null)));break;
      }
      case 'workflow-replan': {
        if(!values.file)throw new Error('--file replan.json is required');
        print(await new WorkflowManager(engine).replan(id,await readJson(values.file,null)));break;
      }
      case 'delivery': print(await engine.delivery(id));break;
      case 'workflow-status': print({plan:await new WorkflowManager(engine).read(id),result:await new WorkflowManager(engine).consolidate(id)});break;
      case 'workflow-start': print(await new WorkflowManager(engine).start(id,{totalTimeoutMs:Number(values.timeout),concurrency:values.concurrency?Number(values.concurrency):undefined}));break;
      case 'workflow-cancel': print(await new WorkflowManager(engine).cancel(id));break;
      case 'workflow-run': {
        const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
        try {const result=await new WorkflowManager(engine).run(id,{totalTimeoutMs:Number(values.timeout),concurrency:values.concurrency?Number(values.concurrency):undefined,signal:controller.signal});print(result);if(result.status!=='completed')process.exitCode=2;}
        finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}break;
      }
      case 'knowledge-index': {
        const profile=await engine.registry.resolve(values.project??'');
        print(await new KnowledgeIndex(root).build(profile,await engine.projectContext(profile.id)));break;
      }
      case 'knowledge-search': {
        if(!values.file)throw new Error('--file search.json (indexId, jobId, options) is required');
        const input=await readJson(values.file,null),manifest=await readJson(path.join(engine.artifactDir(input.jobId),'manifest.json'),null);
        if(!manifest?.taskContract)throw new Error('Job has no saved task contract');
        print(await new KnowledgeIndex(root).search(input.indexId,manifest.taskContract,input.options));break;
      }
      case 'learning-list': print(await new KnowledgeLearningStore(root).list(values.project));break;
      case 'learning-read': print(await new KnowledgeLearningStore(root).read(id));break;
      case 'learning-shadow-source': print(await new KnowledgeLearningStore(root).shadowSource(id));break;
      case 'learning-propose': case 'learning-review': case 'learning-shadow': case 'learning-promote': case 'learning-revert': {
        if(!values.file)throw new Error('--file learning-input.json is required');
        const input=await readJson(values.file,null),learning=new KnowledgeLearningStore(root);
        print(command==='learning-propose'?await learning.propose(input):command==='learning-review'?await learning.review(id,input):command==='learning-shadow'?await learning.shadow(id,input):command==='learning-promote'?await learning.promote(id,input):await learning.revert(id,input));break;
      }
      case 'security-report': {
        if (!values.project || !values.file) throw new Error('--project and --file gate-input.json are required');
        const receipt = await new SecurityIntegrationFacade(root, engine.registry).evaluate(values.project, await readJson(values.file, null));
        print(receipt); if (receipt.effective.commandExitCode !== 0) process.exitCode = receipt.effective.commandExitCode; break;
      }
      case 'projects': print(await engine.registry.list()); break;
      case 'register': {
        if (!values.file) throw new Error('--file profile.json is required');
        print(await engine.profiles.register(await readJson(values.file,null),values.replace)); break;
      }
      case 'context': print(await engine.projectContext(values.project ?? '')); break;
      case 'task-context': {
        if(!values.file)throw new Error('--file task.json is required');
        print(await engine.previewContext(await readJson(values.file,null)));break;
      }
      case 'prepare': {
        if(values.file){print(await engine.prepare(await readJson(values.file,null)));break;}
        if (!values.project || !values.objective || !values.key || !values.checks) throw new Error('--project, --objective, --key and --checks are required');
        if (values.mode !== 'read-only' && values.mode !== 'workspace-write') throw new Error('Invalid --mode');
        if (values.kind !== 'checks' && values.kind !== 'codex') throw new Error('Invalid --kind');
        if (values.workspace !== 'in-place' && values.workspace !== 'worktree') throw new Error('Invalid --workspace');
        print(await engine.prepare({project:values.project,objective:values.objective,idempotencyKey:values.key,mode:values.mode,kind:values.kind,checkIds:values.checks.split(','),dependencyIds:values.depends?.split(',') ?? [],requirementIds:values.requirements?.split(',') ?? [],workspace:values.workspace,...(values['base-ref']?{baseRef:values['base-ref']}:{})})); break;
      }
      case 'run': {
        const timeout = Number(values.timeout);
        if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 1800000) throw new Error('Timeout must be 1000–1800000 ms');
        const result = await engine.run(id, timeout); print(result);
        if (result.status !== 'completed') process.exitCode = 2; break;
      }
      case 'status': print(id ? engine.state.get(id) : engine.state.list()); break;
      case 'start-queue': print(await new SupervisorManager(root).start({maxJobs:Number(values['max-jobs']),totalTimeoutMs:Number(values.timeout),concurrency:values.concurrency?Number(values.concurrency):undefined,jobIds:values.jobs?.split(','),continueIndependent:values['continue-independent']})); break;
      case 'queue-status': print(await new SupervisorManager(root).status(id)); break;
      case 'stop-queue': print(await new SupervisorManager(root).cancel(id)); break;
      case 'drain': {
        const controller = new AbortController();
        const stop = () => controller.abort(); process.once('SIGINT',stop); process.once('SIGTERM',stop);
        try { const result = await new QueueCoordinator(engine).drain({maxJobs:Number(values['max-jobs']),totalTimeoutMs:Number(values.timeout),signal:controller.signal,concurrency:values.concurrency?Number(values.concurrency):undefined,jobIds:values.jobs?.split(','),continueIndependent:values['continue-independent']}); print(result); if(!['max_jobs','no_ready_jobs'].includes(result.stopReason)) process.exitCode=2; }
        finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);} break;
      }
      case 'events': print(engine.state.events(id)); break;
      case 'cancel': print(await engine.cancel(id)); break;
      case 'retry': print(engine.retry(id,values['fresh-thread'])); break;
      case 'confirm-stopped': print(await engine.confirmProcessesStopped(id,values.evidence ?? '')); break;
      case 'reconcile': print(await engine.reconcile()); break;
      default: throw new Error('Unknown command: ' + command);
    }
  }
} catch (error) { process.stderr.write(JSON.stringify({error: error instanceof Error ? error.message : String(error)}) + '\n'); process.exitCode = 1; }
finally { engine?.close(); }
