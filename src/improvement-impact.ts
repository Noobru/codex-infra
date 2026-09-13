import {EvaluationStore,type EvaluationReceipt,type EvaluationMetric} from './evaluation.js';
import {KnowledgeLearningStore,type KnowledgeCandidate} from './knowledge-learning.js';
import type {EfficiencyHistoryResult} from './efficiency-history.js';
import {OperationalInsights,type AttemptExecutionEvidence} from './operational-insights.js';
import {LearningRuntimeEffects,type LearningRuntimeUsage} from './learning-runtime-effects.js';

export interface ImprovementSample {
  attempts:number;knownOutcomes:number;failedAttempts:number;failureRate:number|null;repeatAttempts:number;
  evaluationIds:string[];jobIds:string[];
}
export interface ImprovementImpact {
  runtime?:Pick<LearningRuntimeUsage,'status'|'hash'|'activatedAt'|'disabledAt'|'executions'|'passed'|'failed'>;
  candidateId:string;projectId:string;title:string;kind:string;status:string;problem:string;proposedChange:string;language:string|null;
  expectedChange:string|null;introducedAt:string|null;reversedAt:string|null;contextInclusions:number;
  baseline:ImprovementSample;after:ImprovementSample;failureRateDelta:number|null;repeatAttemptDelta:number|null;
  comparisons:{metricId:string;metricLabel:string;baseline:number;after:number;difference:number;unit:string;cohort:string;beforeN:number;afterN:number}[];
  evidence:string[];nextEvidence:string[];
}

/** Descriptive learning effects, using declared baselines and exact captured content bindings. */
export class ImprovementImpactReader {
  private readonly insights:OperationalInsights;
  constructor(readonly root:string){this.insights=new OperationalInsights(root);}
  async read(history:EfficiencyHistoryResult,projectId?:string) {
    const store=new EvaluationStore(this.root),inventory=await store.list({projectId,limit:100});
    const receipts=[...inventory.items],inventoryWarnings=[...inventory.warnings];let inventoryTruncated=inventory.truncated;
    let offset=inventory.nextOffset;
    while(offset!==null&&receipts.length<500) {
      const page=await store.list({projectId,limit:100,offset});receipts.push(...page.items);offset=page.nextOffset;inventoryWarnings.push(...page.warnings);inventoryTruncated ||= page.truncated;
    }
    const knowledge=await new KnowledgeLearningStore(this.root).list(projectId);
    const warnings=[...inventoryWarnings,...knowledge.warnings];let executionTruncated=false;
    const jobs=new Map<string,Promise<Awaited<ReturnType<OperationalInsights['executionEvidence']>>>>();
    const observed=new Map<string,AttemptExecutionEvidence>();
    const evidence=async(receipt:EvaluationReceipt)=>{
      if(!jobs.has(receipt.jobId)){
        if(jobs.size>=500){executionTruncated=true;warnings.push('Captured execution inventory is limited to 500 jobs.');return undefined;}
        jobs.set(receipt.jobId,this.insights.executionEvidence(receipt.jobId));
      }
      try {
        const result=await jobs.get(receipt.jobId)!;
        warnings.push(...result.warnings);executionTruncated ||= result.truncated;
        const attempt=result.attempts.find(attempt=>attempt.attempt===receipt.attempt);
        if(attempt)observed.set(receipt.jobId+'/'+receipt.attempt,attempt);
        return attempt;
      }catch{warnings.push(receipt.jobId+': captured execution evidence is unavailable.');return undefined;}
    };
    const cases:ImprovementImpact[]=[];
    for(const candidate of knowledge.items.slice(0,100)){
      const requested=candidate.impact?.baselineEvaluationIds??[];
      const baselineIds=new Set(requested);
      if(!baselineIds.size&&'jobId' in candidate.origin) {
        const origin=candidate.origin;
        const recorded=origin.evaluationId?receipts.find(r=>r.id===origin.evaluationId)
          :receipts.find(r=>r.jobId===origin.jobId&&r.attempt===origin.attempt);
        if(recorded)baselineIds.add(recorded.id);
      }
      const baseline:EvaluationReceipt[]=[];
      for(const id of baselineIds) {
        try {
          const receipt=receipts.find(r=>r.id===id)??await store.read(id);
          if(receipt.projectId!==candidate.projectId)throw new Error('project');
          const attempt=await evidence(receipt);
          if(!this.outcomeKey(receipt,candidate,attempt))throw new Error('execution boundary or check cohort is unknown');
          if(candidate.promotion&&Date.parse(attempt!.window!.end)>Date.parse(candidate.promotion.recordedAt))throw new Error('baseline follows introduction');
          baseline.push(receipt);
        } catch {warnings.push(candidate.id+': baseline '+id+' unavailable, lacks captured execution/scope/command evidence, or is outside its declared boundary.');}
      }
      const before=this.uniqueAttempts(baseline);
      const key=(receipt:EvaluationReceipt)=>this.outcomeKey(receipt,candidate,observed.get(receipt.jobId+'/'+receipt.attempt));
      const compatible=new Set(before.map(key));
      const bindings=history.knowledgeBindings.filter(binding=>binding.candidateId===candidate.id);
      const included=new Set(bindings.map(binding=>binding.jobId+'/'+binding.attempt));
      const later:EvaluationReceipt[]=[];
      for(const receipt of receipts.filter(receipt=>receipt.projectId===candidate.projectId&&included.has(receipt.jobId+'/'+receipt.attempt)
        &&!before.some(value=>value.jobId===receipt.jobId&&value.attempt===receipt.attempt))) {
        const attempt=await evidence(receipt),cohort=key(receipt);
        if(cohort&&compatible.has(cohort)&&candidate.promotion&&Date.parse(attempt!.window!.end)>=Date.parse(candidate.promotion.recordedAt))later.push(receipt);
      }
      const after=this.uniqueAttempts(later);
      const b=this.sample(before,candidate),a=this.sample(after,candidate);
      const outcomeCohorts=new Set([...before,...after].map(key));
      const oneOutcomeCohort=outcomeCohorts.size===1&&!outcomeCohorts.has(null);
      const nextEvidence=[];
      if(!candidate.impact)nextEvidence.push('Declare the recurring problem, language and the change expected from this candidate.');
      if(!before.length)nextEvidence.push('Link baseline evaluations for the affected work.');
      if(!candidate.promotion)nextEvidence.push('Review and validate the candidate before an explicit promotion.');
      else if(!bindings.length)nextEvidence.push('Await attempts whose context captures this exact promoted content.');
      if(bindings.length&&!after.length)nextEvidence.push('Await evaluations compatible with the declared baseline.');
      if(outcomeCohorts.size>1)nextEvidence.push('Baseline contains multiple execution cohorts; outcome deltas remain separate instead of pooling unlike workloads.');
      cases.push({candidateId:candidate.id,projectId:candidate.projectId,title:candidate.title,kind:candidate.kind,status:candidate.status,
        problem:candidate.impact?.problem??candidate.title,proposedChange:candidate.content,language:candidate.impact?.language??null,expectedChange:candidate.impact?.expectedChange??null,
        introducedAt:candidate.promotion?.recordedAt??null,reversedAt:candidate.reversal?.recordedAt??null,contextInclusions:bindings.length,
        baseline:b,after:a,failureRateDelta:oneOutcomeCohort&&b.failureRate!==null&&a.failureRate!==null?a.failureRate-b.failureRate:null,
        repeatAttemptDelta:oneOutcomeCohort&&b.attempts&&a.attempts?a.repeatAttempts/a.attempts-b.repeatAttempts/b.attempts:null,
        comparisons:this.metricDifferences(before,after,key),evidence:[...new Set([candidate.artifactPath,...candidate.originEvidence.refs,
          ...before.map(r=>r.artifactPath),...after.map(r=>r.artifactPath),...[...before,...after].flatMap(receipt=>observed.get(receipt.jobId+'/'+receipt.attempt)?.evidence??[]),...bindings.flatMap(binding=>binding.evidence)])],nextEvidence});
    }
    const runtime=await new LearningRuntimeEffects(this.root).read({projectId,history});
    warnings.push(...runtime.warnings);
    for(const item of cases){
      const capabilities=runtime.items.filter(cap=>cap.candidateId===item.candidateId).sort((a,b)=>(b.activatedAt??'').localeCompare(a.activatedAt??''));
      const cap=capabilities.find(cap=>cap.status==='active')??capabilities[0];
      if(cap){
        item.runtime={status:cap.status,hash:cap.hash,activatedAt:cap.activatedAt,disabledAt:cap.disabledAt,executions:cap.executions,passed:cap.passed,failed:cap.failed};
        item.nextEvidence=item.nextEvidence.filter(text=>!text.includes('before an explicit promotion'));
        item.nextEvidence.push(cap.status==='active'?(cap.executions?'Compare attributed executions with compatible baselines; savings are not established.':'Capability active; awaiting its first recorded execution.'):`Executable version is ${cap.status}; activation is separate from manual knowledge promotion.`);
      }
    }
    return {cases,warnings:[...new Set(warnings)],truncated:knowledge.items.length>100||offset!==null||inventoryTruncated||executionTruncated||runtime.coverage.truncated,
      method:'Declared baseline versus evaluated attempts with captured execution windows, matching task scope/check commands and exact promoted content in context. Counts include failed gates; outcome deltas require one compatible cohort and metric averages use individual observations only. Context inclusion does not certify correct application or cause.',
      tokens:'Desktop token trends are measured per completed turn; they are not assigned to an individual error or candidate without a matching scoped record.'};
  }
  private contractKey(receipt:EvaluationReceipt) {
    return JSON.stringify([receipt.projectId,receipt.taskClass,receipt.rubric.id,receipt.rubric.version,
      receipt.rubric.criteria.map(c=>[c.checkId,c.critical]).sort()]);
  }
  private outcomeKey(receipt:EvaluationReceipt,candidate:KnowledgeCandidate,execution:AttemptExecutionEvidence|undefined) {
    if(!execution?.window||execution.projectId!==receipt.projectId||!Number.isFinite(Date.parse(execution.window.start))||!Number.isFinite(Date.parse(execution.window.end)))return null;
    if(candidate.impact?.language&&candidate.impact.language.trim().toLowerCase()!==execution.performanceScope?.language?.trim().toLowerCase())return null;
    const affected=candidate.impact?.affectedCheckIds?.length?candidate.impact.affectedCheckIds:receipt.rubric.criteria.map(criterion=>criterion.checkId);
    const checks=[...new Set(affected)].sort().map(id=>execution.checks.find(check=>check.checkId===id));
    if(!checks.length||checks.some(check=>!check?.cohort))return null;
    return JSON.stringify([this.contractKey(receipt),execution.contractFingerprint,checks.map(check=>[check!.checkId,check!.cohort])]);
  }
  private uniqueAttempts(receipts:EvaluationReceipt[]) {
    const unique=new Map<string,EvaluationReceipt>();
    for(const receipt of [...receipts].sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)))unique.set(receipt.jobId+'/'+receipt.attempt,receipt);
    return [...unique.values()];
  }
  private sample(receipts:EvaluationReceipt[],candidate:KnowledgeCandidate):ImprovementSample {
    const affected=candidate.impact?.affectedCheckIds??[];
    const outcomes=receipts.map(receipt=>{
      const criteria=receipt.technical.criteria.filter(criterion=>!affected.length||affected.includes(criterion.checkId));
      if(!criteria.length||affected.some(id=>!criteria.some(c=>c.checkId===id)))return 'unknown';
      return criteria.some(c=>c.status==='failed')?'failed':criteria.every(c=>c.status==='passed')?'passed':'unknown';
    });
    const knownOutcomes=outcomes.filter(value=>value!=='unknown').length,failedAttempts=outcomes.filter(value=>value==='failed').length;
    return {attempts:receipts.length,knownOutcomes,failedAttempts,failureRate:knownOutcomes?failedAttempts/knownOutcomes:null,
      repeatAttempts:receipts.filter(r=>r.attempt>1).length,evaluationIds:receipts.map(r=>r.id),jobIds:[...new Set(receipts.map(r=>r.jobId))]};
  }
  private metricDifferences(before:EvaluationReceipt[],after:EvaluationReceipt[],executionKey:(receipt:EvaluationReceipt)=>string|null) {
    const groups=(receipts:EvaluationReceipt[])=>{
      const result=new Map<string,{metric:EvaluationMetric;metricLabel:string;values:number[]}>();
      for(const receipt of receipts.filter(receipt=>receipt.technical.criticalGateStatus==='passed'))for(const metric of receipt.metrics){
        if(metric.classification!=='observed'||metric.sample.size!==1)continue;
        const key=JSON.stringify([executionKey(receipt),metric.id,metric.unit,metric.method,metric.version,metric.cohort]);
        const group=result.get(key)??{metric,metricLabel:this.insights.metricLabel(receipt,metric.id),values:[]};group.values.push(metric.value);result.set(key,group);
      }
      return result;
    };
    const baseline=groups(before),treatment=groups(after),result:ImprovementImpact['comparisons']=[];
    for(const [key,b] of baseline) {
      const a=treatment.get(key);if(!a)continue;
      const avg=(values:number[])=>values.reduce((sum,n)=>sum+n,0)/values.length;
      const bv=avg(b.values),av=avg(a.values);
      result.push({metricId:b.metric.id,metricLabel:b.metricLabel,baseline:bv,after:av,difference:av-bv,unit:b.metric.unit!,cohort:b.metric.cohort!,beforeN:b.values.length,afterN:a.values.length});
    }
    return result;
  }
}
