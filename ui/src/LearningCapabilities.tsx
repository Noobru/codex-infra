import {ArrowUpRight,Clipboard,FileCheck2,LockKeyhole,TerminalSquare,TriangleAlert,Workflow,Zap} from 'lucide-react';
import type {DashboardObservation} from './api';
import {CopyId,EmptyState,InfoCard,ScopeNote,SectionHeading,timestamp,type CopyProps} from './components';

type Props={source:DashboardObservation['learningRuntime']}&CopyProps;
const labels={packaged:'Packaged',reviewed:'Reviewed',rejected:'Review rejected','validation-passed':'Validation passed',
  'validation-failed':'Validation failed',active:'Active',disabled:'Disabled'};
const stages={queued:'Queued',building:'Building',reviewing:'Reviewing',validating:'Validating',active:'Active',attention:'Needs attention',disabled:'Disabled'};

export function LearningCycle({source,onOpenRun,...copy}:{source:DashboardObservation['learningCycle'];onOpenRun:(id:string)=>void}&CopyProps){
  const items=source?.data?.items;
  return <>
    <SectionHeading label="Automatic learning" title="From a signal to an active improvement" count={source?.state??'unavailable'}/>
    {!items&&<EmptyState title="Learning cycle unavailable" detail="Refresh to read the recorded cases. No progress was inferred."/>}
    {items?.length===0&&<EmptyState title={source?.state==='partial'?'No learning cases could be verified':'No automatic learning cases recorded'} detail={source?.state==='partial'?'Some records could not be read. Review the source warnings before treating this scope as empty.':'Eligible recurring failures and recorded findings can enter the governed build and validation cycle.'}/>}
    {!!source?.warnings.length&&<ScopeNote>{source.warnings.join(' ')}</ScopeNote>}
    <div className="evaluation-list">{items?.map(item=><InfoCard key={item.id} icon={item.status==='attention'?TriangleAlert:item.status==='active'?Zap:item.status==='disabled'?LockKeyhole:Workflow}
      title={item.title} meta={`${item.projectId} · ${stages[item.status]}`}>
      <div className="card-list"><span>{item.kind} · build attempts: {item.attempts} · updated {timestamp(item.updatedAt)}</span>
        {item.lastError&&<span>Last recorded issue: {item.lastError}</span>}
      </div>
      {item.hash&&<div className="hash-line"><span>Bundle hash</span><CopyId value={item.hash} {...copy}/></div>}
      {item.originJobId&&<button className="subtle-link" type="button" onClick={()=>onOpenRun(item.originJobId!)}>Inspect origin run<ArrowUpRight size={15}/></button>}
      <details className="receipt-details"><summary>Case evidence and execution runs ({item.jobIds.length})</summary>
        <div className="hash-line"><CopyId value={item.id} {...copy}/></div>
        {item.candidateId&&<div className="hash-line"><span>Candidate</span><CopyId value={item.candidateId} {...copy}/></div>}
        {item.jobIds.map(id=><button key={id} className="subtle-link" type="button" onClick={()=>onOpenRun(id)}>Inspect execution run {id.slice(0,8)}<ArrowUpRight size={15}/></button>)}
        {[...new Set([item.artifactPath,...item.evidence])].map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}
      </details>
    </InfoCard>)}</div>
  </>;
}

export function LearningCapabilities({source,...copy}:Props){
  const items=source?.data?.items;
  const updates=items?.filter(item=>['active','disabled','rejected','validation-failed'].includes(item.state.status))??[];
  return <>
    <SectionHeading label="Executable learning" title="Skills and scripts" count={source?.state??'unavailable'}/>
    {!items&&<EmptyState title="Capability inventory unavailable" detail="Refresh to read the local bundle records. No active or empty result was inferred."/>}
    {items?.length===0&&<EmptyState title={source?.state==='partial'?'No executable bundles could be verified':'No executable bundles in this scope'} detail={source?.state==='partial'?'Some bundle records failed to load or verify. Review the source warnings before treating this scope as empty.':'A candidate becomes executable after a bundle has been built, reviewed and tested. Activation is recorded separately.'}/>}
    {!!source?.warnings.length&&<ScopeNote>{source.warnings.join(' ')}</ScopeNote>}
    {updates.length>0&&<details className="receipt-details"><summary>Activation and blocked updates ({updates.length})</summary>
      <div className="card-list">{updates.map(({manifest,state})=><div key={manifest.hash}>
        <strong>{labels[state.status]} · {manifest.title}</strong>
        <span> · {timestamp(state.disabled?.recordedAt??state.activation?.recordedAt??state.updatedAt)}</span>
        <div className="hash-line"><CopyId value={manifest.hash} {...copy}/></div>
      </div>)}</div>
    </details>}
    <div className="evaluation-list">{items?.map(({manifest,state})=>{
      const disabled=state.status==='disabled';
      const blocked=disabled||state.status==='rejected'||state.status==='validation-failed';
      const request=`Disable the CodexInfra capability with hash ${manifest.hash} in project ${manifest.projectId}. Preserve its history and prevent further use of this version.`;
      const evidence=[manifest.artifactPath,state.artifactPath,state.validation?.path,...(state.activation?.evidence??[]),...(state.disabled?.evidence??[])].filter((ref):ref is string=>Boolean(ref));
      return <InfoCard key={manifest.hash} icon={disabled?LockKeyhole:blocked?TriangleAlert:state.status==='active'?Zap:TerminalSquare}
        title={manifest.title} meta={`${manifest.projectId} · ${manifest.kind} ${manifest.capabilityVersion} · ${labels[state.status]}`}>
        <div className="card-list">
          <span>{state.activation?`Activated ${timestamp(state.activation.recordedAt)}`:'No activation recorded'} · updated {timestamp(state.updatedAt)}</span>
          {state.activation&&<span>Activation source: {state.activation.source}</span>}
          {state.disabled&&<span>Disabled {timestamp(state.disabled.recordedAt)} · {state.disabled.source}</span>}
          {state.status==='validation-failed'&&<span>Validation failed. This version is not active; inspect the validation receipt below.</span>}
          {state.status==='rejected'&&<span>Review rejected this version. Inspect the state receipt below.</span>}
        </div>
        <div className="hash-line"><span>Bundle hash</span><CopyId value={manifest.hash} {...copy}/></div>
        <details className="receipt-details"><summary>Entrypoints ({manifest.entrypoints.length}) and evidence</summary>
          <div className="card-list">{manifest.entrypoints.map(entry=><span key={entry.id}>{entry.id} · {entry.runtime} · {entry.path}</span>)}
            <span><FileCheck2 size={13}/> {manifest.testCount} bundled tests · {state.validation?'validation receipt recorded':'not yet validated'}</span>
          </div>
          <div className="hash-line"><span>Candidate</span><CopyId value={manifest.candidateId} {...copy}/></div>
          {[...new Set(evidence)].map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}
        </details>
        {disabled?<ScopeNote>This hash is disabled. Its records remain available for inspection.</ScopeNote>:<details className="receipt-details">
          <summary>Ask the agent to disable by hash</summary>
          <p className="receipt-text">{request}</p>
          <button className="subtle-link" type="button" onClick={()=>copy.onCopy(request)}><Clipboard size={15}/>{copy.copiedId===request?'Request copied':'Copy disable request'}</button>
        </details>}
      </InfoCard>;
    })}</div>
  </>;
}
