import {TerminalSquare} from 'lucide-react';
import {statusNames} from './LearningCapabilities';
import type {DashboardObservation} from './api';
import {CopyId,EmptyState,InfoCard,ScopeNote,SectionHeading,duration,timestamp,type CopyProps} from './components';

export function LearningRuntimeEffectsView({source,...copy}:{source:DashboardObservation['runtimeEffects']}&CopyProps){
  const data=source?.data;
  return <section aria-label="Execuções registradas de capacidades">
    <SectionHeading label="Uso e resultado" title="Capacidades executadas" count={data?.window?`${data.window.days} dias · ${data.timeZone}`:source?.state??'unavailable'}/>
    {!data&&<EmptyState title="Uso indisponível nesta leitura" detail="Atualize para consultar as chamadas no período selecionado."/>}
    {data?.items.length===0&&<EmptyState title={source?.state==='partial'?'Não foi possível verificar as capacidades':'Nenhuma capacidade registrada'} detail={source?.state==='partial'?'O inventário está incompleto. Confira os avisos da fonte.':'As capacidades aparecem aqui com a ativação e as chamadas registradas.'}/>}
    {!!source?.warnings.length&&<ScopeNote>{source.warnings.join(' ')}</ScopeNote>}
    <div className="evaluation-list">{data?.items.map(item=><InfoCard key={item.hash} icon={TerminalSquare} title={item.title} meta={`${item.projectId} · v${item.capabilityVersion} · ${statusNames[item.status]??item.status}`}>
      <div className="card-list">
        <span>{item.activatedAt?`Ativada em ${timestamp(item.activatedAt)}`:'Sem ativação registrada'}{item.disabledAt?` · Desativada em ${timestamp(item.disabledAt)}`:''}</span>
        <span><strong>{item.executions} chamadas verificadas</strong> · {item.passed} com sucesso · {item.failed} com falha</span>
        <span>Tempo de execução: {item.metrics.totalDuration.value===null?'não registrado':duration(item.metrics.totalDuration.value)} no total · {item.metrics.meanDuration.value===null?'não registrado':duration(item.metrics.meanDuration.value)} por chamada</span>
        <span><strong>{item.tokenEffects.status==='observed'?'Comparação disponível':'Comparação pendente'}</strong> · {item.attributedExecutions} de {item.executions} chamadas com referência ao turno.</span>
        {item.tokenEffects.reasons.map(reason=><span key={reason}>{reason}</span>)}
      </div>
      {item.tokenEffects.groups.length>0&&<details className="receipt-details"><summary>Comparar tokens de trabalhos equivalentes</summary>
        <p>Cada grupo usa o mesmo projeto, escopo declarado, modelo e esforço. Várias chamadas no mesmo turno contam como um turno; falhas de execução também permanecem na amostra. Diferença observada não prova economia causada pela capacidade.</p>
        {item.tokenEffects.groups.map(group=><div className="measurement-record" key={group.id}>
          <strong>{group.modelIdentity?.model} · {group.modelIdentity?.effort} · {group.performanceScope?.taskClass}</strong>
          <span>{group.performanceScope?.language} · {group.performanceScope?.problemCategory}</span>
          <span>Antes da ativação: {group.baselineTurns} turnos · Com execução: {group.treatmentTurns} turnos</span>
          {group.metrics.filter(metric=>metric.baselineN||metric.treatmentN).map(metric=><span key={metric.metric}>
            {metric.metric}: {metric.baselineMean===null?'sem baseline':Math.round(metric.baselineMean).toLocaleString()} → {metric.treatmentMean===null?'pendente':Math.round(metric.treatmentMean).toLocaleString()} tokens por turno · amostras {metric.baselineN}/{metric.treatmentN}
          </span>)}
          <details><summary>Evidências da comparação</summary>{group.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}</details>
        </div>)}
      </details>}
      {item.executions>0&&<details className="receipt-details"><summary>Histórico diário e evidências das chamadas</summary>
        <div className="card-list">{item.days.map(day=><span key={day.day}>{day.day}: {day.executions} chamadas · {day.passed} com sucesso / {day.failed} com falha · {duration(day.totalDurationMs)} no total / {duration(day.meanDurationMs)} por chamada</span>)}</div>
        {item.runs.map(run=><div className="measurement-record" key={run.id}>
          <strong>{run.entrypoint} · {run.status} · {duration(run.durationMs)}</strong><span>{timestamp(run.recordedAt)}{run.disabledDuringExecution?' · desativada durante esta chamada':''}</span>
          <div className="hash-line"><CopyId value={run.artifactPath} {...copy}/></div>
          {run.outputs.map(output=><div className="hash-line" key={output.path}><span>{output.path} · {output.bytes} bytes</span><CopyId value={output.sha256} {...copy}/></div>)}
          {run.attribution&&<details><summary>Referência ao turno</summary><div className="hash-line"><span>Tarefa</span><CopyId value={run.attribution.threadId} {...copy}/></div><div className="hash-line"><span>Turno</span><CopyId value={run.attribution.turnId} {...copy}/></div></details>}
        </div>)}
      </details>}
      <details className="receipt-details"><summary>Ativação e método de medição</summary>
        <div className="hash-line"><span>Hash desta versão</span><CopyId value={item.hash} {...copy}/></div>
        <p>O tempo total soma as execuções desta versão; a média divide esse total pelas chamadas verificadas. A amostra ainda pode ser pequena ou pouco representativa.</p>
        {item.evidence.slice(0,2).map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}
      </details>
    </InfoCard>)}</div>
    {data&&<ScopeNote>Os tempos cobrem a execução da capacidade. Conversa, geração e build ficam fora dessa duração. Um resultado retornado ainda precisa ser aplicado ao trabalho; estas medidas sozinhas não comprovam economia.</ScopeNote>}
  </section>;
}
