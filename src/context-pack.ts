import { createHash } from 'node:crypto';
import type { ProjectContext, ContextSource } from './registry.js';
import type { TaskContract } from './task-contract.js';

export interface ContextPack {
  version: 1; selectorVersion: string; hash: string; projectId: string; taskContractHash: string;
  capturedAt: string; profileHash: string; git: ProjectContext['git'];
  sources: (ContextSource & {selectionReason:string; requiresFullRead:boolean})[];
  excludedSources: {path:string; label:string; sha256:string; reason:string}[];
  budget: {limitChars:number; includedChars:number; availableChars:number};
  governance?: {
    decisionRefs: {requested:string[]; resolved:string[]; unresolved:string[]};
    precedence: {label:string; path:string; value:number; configured:boolean; included:boolean}[];
    conflicts: {
      sourceLabel:string; targetLabel:string; sourcePath:string; targetPath:string|null;
      targetStatus:'found'|'missing'|'ambiguous'; sourceIncluded:boolean; targetIncluded:boolean;
      sourcePrecedence:number; targetPrecedence:number|null;
      ordering:'source-first'|'target-first'|'equal'|'unknown'; resolution:'unresolved';
    }[];
    diagnostics:string[];
  };
  limitations: string[];
}

/** Select only registry-validated sources; never scans another project or promotes knowledge. */
export class ContextPackBuilder {
  build(context:ProjectContext, contract:TaskContract, options:{additionalSourceLabels?:string[]} = {}): ContextPack {
    if(context.projectId !== contract.projectId) throw new Error('Context Pack project differs from task contract');
    const required = new Set(contract.details.requiredSourceLabels);
    const additional = new Set(options.additionalSourceLabels ?? []);
    const decisionRefs = [...new Set(contract.details.decisionRefs)];
    for(const label of required) {
      const matches=context.sources.filter(source=>source.label===label);
      if(matches.length!==1) throw new Error('Required context source is missing or ambiguous: '+label);
    }
    const terms=[...new Set((contract.objective+' '+contract.details.acceptanceCriteria.join(' ')+' '+contract.requirementIds.join(' '))
      .toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])];
    const candidates=context.sources.map((source,index)=>{
      const haystack=[source.label,source.path,...(source.topics??[]),source.excerpt].join(' ').toLocaleLowerCase('pt-BR');
      const score=terms.filter(term=>haystack.includes(term)).length;
      const inactive=source.knowledgeStatus && source.knowledgeStatus!=='active';
      const expired=source.validUntil && Date.parse(source.validUntil)<=Date.parse(context.capturedAt);
      const inactiveClass=source.knowledgeClass==='candidate'||source.knowledgeClass==='historical';
      const unavailable=inactive?'knowledge-is-'+source.knowledgeStatus:inactiveClass?'knowledge-class-'+source.knowledgeClass:expired?'source-expired':null;
      const decisionMatch=unavailable===null && decisionRefs.some(ref=>source.decisionRefs?.includes(ref));
      const mandatory=source.kind==='instruction'||required.has(source.label)||decisionMatch;
      return {source,index,mandatory,score,unavailable,decisionMatch,precedence:source.precedence??0};
    }).sort((a,b)=>Number(b.mandatory)-Number(a.mandatory)||b.precedence-a.precedence||b.score-a.score||a.index-b.index);
    const sources:ContextPack['sources']=[], excludedSources:ContextPack['excludedSources']=[];
    const limitChars=contract.details.contextBudgetChars;
    let includedChars=0;
    for(const entry of candidates) {
      const {source,mandatory,score,unavailable,decisionMatch}=entry;
      if(unavailable && mandatory) throw new Error('Mandatory context source is inactive or expired: '+source.label);
      const reason=unavailable ?? (!mandatory && score===0 && !additional.has(source.label)?'no-lexical-match':null)
        ?? (includedChars+source.excerpt.length>limitChars?'context-budget':null);
      if(reason) {
        if(mandatory) throw new Error('Mandatory context exceeds budget; increase it or narrow the registered excerpts');
        excludedSources.push({path:source.path,label:source.label,sha256:source.sha256,reason});
      } else {
        sources.push({...source,selectionReason:source.kind==='instruction'?'applicable-instruction':required.has(source.label)?'explicit-source':decisionMatch?'active-decision-reference':score>0?'lexical-match':'explicit-graph-link',requiresFullRead:source.truncated});
        includedChars+=source.excerpt.length;
      }
    }
    const resolved=decisionRefs.filter(ref=>sources.some(source=>source.decisionRefs?.includes(ref)));
    const unresolved=decisionRefs.filter(ref=>!resolved.includes(ref));
    const governance:NonNullable<ContextPack['governance']>={
      decisionRefs:{requested:decisionRefs,resolved,unresolved},
      precedence:candidates.map(entry=>({label:entry.source.label,path:entry.source.path,value:entry.precedence,configured:entry.source.precedence!==undefined,included:sources.some(source=>source.path===entry.source.path&&source.label===entry.source.label)})),
      conflicts:[],diagnostics:unresolved.map(ref=>'Decision reference has no included active source: '+ref),
    };
    const included=(source:ContextSource)=>sources.some(selected=>selected.path===source.path&&selected.label===source.label);
    for(const source of context.sources) {
      for(const label of new Set(source.conflictsWith??[])) {
        const matches=context.sources.filter(target=>target.label===label);
        const target=matches.length===1?matches[0]:undefined;
        const sourcePrecedence=source.precedence??0,targetPrecedence=target?(target.precedence??0):null;
        governance.conflicts.push({sourceLabel:source.label,targetLabel:label,sourcePath:source.path,targetPath:target?.path??null,
          targetStatus:matches.length===0?'missing':matches.length>1?'ambiguous':'found',sourceIncluded:included(source),targetIncluded:target?included(target):false,
          sourcePrecedence,targetPrecedence,ordering:targetPrecedence===null?'unknown':sourcePrecedence>targetPrecedence?'source-first':sourcePrecedence<targetPrecedence?'target-first':'equal',resolution:'unresolved'});
      }
    }
    if(governance.conflicts.length)governance.diagnostics.push('Declared conflicts remain unresolved. Precedence orders context only; it does not authorize choosing a conflicting rule.');
    const body={version:1 as const,selectorVersion:'lexical-v2-governance',projectId:context.projectId,taskContractHash:contract.hash,
      capturedAt:context.capturedAt,profileHash:context.profileHash,git:context.git,sources,excludedSources,governance,
      budget:{limitChars,includedChars,availableChars:context.sources.reduce((sum,s)=>sum+s.excerpt.length,0)},
      limitations:['Selection uses explicit task decision references, declared precedence and lexical matching, not semantic conflict detection.','Required sources precede optional sources; higher precedence orders candidates within each group, then lexical score and registry order. Precedence does not grant authority or resolve conflicts.','Unresolved decision references and declared conflicts require review only for actions depending on them; independent reading can continue.','Absence from this pack does not prove a source does not exist.','Truncated sources must be read in full when required for the task; source content and knowledge classes cannot grant authority.','This pack records capture-time freshness; execution regenerates it from current sources.']};
    return {...body,hash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  }
}
