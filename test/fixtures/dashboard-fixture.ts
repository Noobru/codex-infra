import fs from 'node:fs/promises';
import path from 'node:path';
import {StateStore,type JobStatus} from '../../src/state.js';
import {EvaluationStore,type EvaluationInput} from '../../src/evaluation.js';

/** Synthetic UI/API states only. This fixture never invokes a worker or product command. */
export class DashboardFixture {
  readonly ids:Record<string,string>={};
  constructor(readonly root:string){}
  async seed(timelineEvents=0){
    const db=new StateStore(path.join(this.root,'state/jobs.sqlite'));
    const statuses:JobStatus[]=['running','validating','waiting_user','waiting_quota','failed','completed'];
    for(const status of statuses){
      const job=db.create({projectId:`ui-${status.replace('_','-')}`,objective:`UI FIXTURE: ${status} task`,mode:'read-only',idempotencyKey:status,profileHash:'fixture'});
      this.ids[status]=job.id;
      if(['running','validating','completed','failed'].includes(status))db.claim(job.id,process.pid);
      if(['validating','completed'].includes(status))db.transition(job.id,'validating');
      if(!['running','validating'].includes(status))db.transition(job.id,status);
      if(status==='running')for(let index=0;index<timelineEvents;index++)db.transition(job.id,'running',{result:`Synthetic timeline event ${index+1}`});
    }
    // Force pagination and a critical failed attempt while keeping technical completion separate.
    for(let index=0;index<22;index++){
      const job=db.create({projectId:'ui-completed',objective:`UI FIXTURE: archived task ${index}`,mode:'read-only',idempotencyKey:`archive-${index}`,profileHash:'fixture'});
      db.claim(job.id,process.pid);db.transition(job.id,'validating');db.transition(job.id,'completed');
    }
    db.close();
    await fs.mkdir(path.join(this.root,'profiles'),{recursive:true});
    const projects=[...statuses.map(status=>({id:`ui-${status.replace('_','-')}`,name:`UI fixture ${status}`,root:path.join(this.root,'not-a-product'),status:'active',modes:['read-only'],stack:['fixture'],sourceRoots:[],sources:[],checks:[]})),
      {id:'ui-empty',name:'UI fixture empty',root:path.join(this.root,'never-resolve-this'),status:'paused',modes:['read-only'],stack:[],sourceRoots:[],checks:[],sources:[{path:'not-read.md',label:'Candidate from fixture',kind:'reference',knowledgeClass:'candidate'}]}];
    await fs.writeFile(path.join(this.root,'profiles/registry.json'),JSON.stringify({version:1,projects}));
    const attempt=path.join(this.root,'artifacts/jobs',this.ids.completed!,'attempt-1');
    await fs.mkdir(attempt,{recursive:true});
    await fs.writeFile(path.join(attempt,'checks.json'),JSON.stringify([{checkId:'ui-check',exitCode:1,durationMs:158}]));
    const input:EvaluationInput={jobId:this.ids.completed!,attempt:1,taskClass:'ui-fixture',author:{name:'Fixture',role:'reviewer'},source:'synthetic-ui-fixture',evidence:['ui-fixture'],
      rubric:{id:'ui',version:'1',criteria:[{id:'correct',checkId:'ui-check',critical:true}]},
      metrics:[{id:'elapsed',classification:'observed',value:158,unit:'ms',method:'fixture',source:'synthetic-ui-fixture',cohort:'ui',window:{start:'2026-09-12T00:00:00Z',end:'2026-09-12T00:01:00Z'},version:'1',sample:{size:1,representative:false,selection:'one synthetic receipt'}}]};
    await new EvaluationStore(this.root).record(input);
    await fs.writeFile(path.join(this.root,'UI-FIXTURE.json'),JSON.stringify({simulation:true,noWorkerInvoked:true,ids:this.ids}));
    return this;
  }
  async finish(){
    const db=new StateStore(path.join(this.root,'state/jobs.sqlite'));
    try{for(const job of db.list())if(['running','validating'].includes(job.status))db.transition(job.id,'cancelled',{result:'Synthetic UI validation finished; no worker was launched.'});}finally{db.close();}
  }
}
