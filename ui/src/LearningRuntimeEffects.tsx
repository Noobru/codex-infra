import {TerminalSquare} from 'lucide-react';
import type {DashboardObservation} from './api';
import {CopyId,EmptyState,InfoCard,ScopeNote,SectionHeading,duration,timestamp,type CopyProps} from './components';

export function LearningRuntimeEffectsView({source,...copy}:{source:DashboardObservation['runtimeEffects']}&CopyProps){
  const data=source?.data;
  return <section aria-label="Observed capability executions">
    <SectionHeading label="Improvements in use" title="Executed skills and scripts" count={data?.window?`${data.window.days} days · ${data.timeZone}`:source?.state??'unavailable'}/>
    {!data&&<EmptyState title="Execution effects unavailable" detail="Refresh to read capability runs in the selected history window."/>}
    {data?.items.length===0&&<EmptyState title={source?.state==='partial'?'No capabilities could be verified':'No executable capabilities recorded'} detail={source?.state==='partial'?'The receipt inventory is incomplete. Review the source warnings.':'A built capability appears here with its activation and the executions that follow.'}/>}
    {!!source?.warnings.length&&<ScopeNote>{source.warnings.join(' ')}</ScopeNote>}
    <div className="evaluation-list">{data?.items.map(item=><InfoCard key={item.hash} icon={TerminalSquare} title={item.title} meta={`${item.projectId} · v${item.capabilityVersion} · ${item.status}`}>
      <div className="card-list">
        <span>{item.activatedAt?`Activated ${timestamp(item.activatedAt)}`:'No activation recorded'}{item.disabledAt?` · Disabled ${timestamp(item.disabledAt)}`:''}</span>
        <span><strong>{item.executions} verified executions</strong> · {item.passed} passed · {item.failed} failed</span>
        <span>Execution time: {item.metrics.totalDuration.value===null?'not recorded':duration(item.metrics.totalDuration.value)} total · {item.metrics.meanDuration.value===null?'not recorded':duration(item.metrics.meanDuration.value)} mean per call</span>
        {item.attributedExecutions>0&&<span>{item.attributedExecutions} executions include declared turn references; a token effect is not established.</span>}
      </div>
      <div className="hash-line"><span>Capability hash</span><CopyId value={item.hash} {...copy}/></div>
      {item.executions>0&&<details className="receipt-details"><summary>Daily execution history and returned evidence</summary>
        <div className="card-list">{item.days.map(day=><span key={day.day}>{day.day}: {day.executions} calls · {day.passed} passed / {day.failed} failed · {duration(day.totalDurationMs)} total / {duration(day.meanDurationMs)} mean</span>)}</div>
        {item.runs.map(run=><div className="measurement-record" key={run.id}>
          <strong>{run.entrypoint} · {run.status} · {duration(run.durationMs)}</strong><span>{timestamp(run.recordedAt)}{run.disabledDuringExecution?' · disabled while this call was running':''}</span>
          <div className="hash-line"><CopyId value={run.artifactPath} {...copy}/></div>
          {run.outputs.map(output=><div className="hash-line" key={output.path}><span>{output.path} · {output.bytes} bytes</span><CopyId value={output.sha256} {...copy}/></div>)}
          {run.attribution&&<details><summary>Declared turn reference</summary><div className="hash-line"><span>Thread</span><CopyId value={run.attribution.threadId} {...copy}/></div><div className="hash-line"><span>Turn</span><CopyId value={run.attribution.turnId} {...copy}/></div></details>}
        </div>)}
      </details>}
      <details className="receipt-details"><summary>Activation and measurement method</summary>
        <p>Durations sum the recorded execution time for this exact hash; the mean divides it by the number of verified calls. The sample is not declared representative.</p>
        {item.evidence.slice(0,2).map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}
      </details>
    </InfoCard>)}</div>
    {data&&<ScopeNote>These are execution outcomes, not a measure of savings. Interaction, synthesis and build costs are outside these durations. Returned outputs do not prove application to another project.</ScopeNote>}
  </section>;
}
