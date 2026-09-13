import {useState} from 'react';
import type {DashboardObservation} from './api';
import {CopyId,EmptyState,timestamp,duration,type CopyProps} from './components';

const statusNames:Record<string,string>={active:'Ativa',attention:'Precisa de atenção',queued:'Na fila',building:'Em construção',validating:'Em validação',reviewing:'Em revisão',disabled:'Desativada',superseded:'Substituída por caso validado',rejected:'Revisão reprovada','validation-failed':'Teste reprovado',registered:'Pacote gerado',reviewed:'Revisada',validated:'Validada'};
type Props={data:DashboardObservation;onOpenRun:(id:string)=>void}&CopyProps;

/** One story per exact executable version; pending cases stay separate until a bundle exists. */
export function LearningStories({data,onOpenRun,...copy}:Props){
  const [filter,setFilter]=useState('active');
  const cases=data.learningCycle?.data?.items??[];
  const bundles=data.learningRuntime?.data?.items??[];
  const stories=[...bundles.map(bundle=>({id:bundle.manifest.hash,title:bundle.manifest.title,projectId:bundle.manifest.projectId,status:bundle.state.status,
    bundle,origin:cases.find(item=>item.hash===bundle.manifest.hash)??cases.find(item=>item.candidateId===bundle.manifest.candidateId),
    usage:data.runtimeEffects?.data?.items.find(item=>item.hash===bundle.manifest.hash)})),
    ...cases.filter(item=>!bundles.some(bundle=>bundle.manifest.hash===item.hash)).map(origin=>({id:origin.id,title:origin.title,projectId:origin.projectId,status:origin.status,bundle:undefined,origin,usage:undefined}))];
  const bucket=(story:typeof stories[number])=>['disabled','superseded'].includes(story.status)||story.bundle&&bundles.some(bundle=>bundle.manifest.candidateId===story.bundle!.manifest.candidateId&&bundle.manifest.hash!==story.id&&bundle.state.status==='active')?'disabled':story.status==='active'?'active':['attention','rejected','validation-failed'].includes(story.status)?'attention':'progress';
  const filters=[{id:'active',label:'Ativas'},{id:'progress',label:'Em preparação'},{id:'attention',label:'Precisam de atenção'},{id:'disabled',label:'Histórico'}];
  const complete=Boolean(data.learningRuntime?.data&&data.learningCycle?.data);
  const visible=stories.filter(item=>bucket(item)===filter);
  return <>
    <div className="reading-intro"><p className="muted">Capacidades locais executáveis, disponíveis para os agentes. <strong>Ativa</strong> significa disponível; <strong>usada</strong> exige uma chamada registrada.</p></div>
    {!complete&&<EmptyState title="Não foi possível ler todo o aprendizado" detail="Atualize o painel. Os registros disponíveis abaixo não representam o inventário completo."/>}
    {[data.learningCycle?.state,data.learningRuntime?.state,data.runtimeEffects?.state].includes('partial')&&<p className="warning-text">Leitura parcial: as contagens cobrem apenas registros que puderam ser verificados.</p>}
    <div className="view-switch" role="group" aria-label="Etapa do aprendizado">{filters.map(item=><button type="button" key={item.id} aria-pressed={filter===item.id} onClick={()=>setFilter(item.id)}>{item.label}<span>{complete?stories.filter(story=>bucket(story)===item.id).length:'—'}</span></button>)}</div>
    <div className="story-list">{visible.map(item=>{
      const {bundle,origin,usage}=item;
      const reason=origin?.reason??data.operations.data?.learning?.find(candidate=>candidate.id===bundle?.manifest.candidateId)?.contentExcerpt;
      const shortReason=reason?.split(/(?<=\.)\s/)[0];
      const reasonPreview=shortReason&&shortReason.length>420?shortReason.slice(0,420)+'…':shortReason;
      const usageAvailable=Boolean(data.runtimeEffects?.data&&usage);
      const project=data.projects.items.find(project=>project.id===item.projectId);
      return <article className="learning-story" key={item.id}>
        <header className="story-heading"><div><span className="story-project">{project?.name??item.projectId}{project?.population==='fixture'?' · ambiente de teste':''}</span><h2>{item.title}</h2></div><span className={`story-status ${item.status==='active'?'is-active':''}`}>{statusNames[item.status]??item.status}</span></header>
        {item.status!=='superseded'&&<div className="story-reason"><h3>Por que existe</h3><p>{reasonPreview??'O motivo não está disponível nesta fonte. Consulte os registros de origem.'}</p></div>}
        {origin?.recovery&&<div className="story-reason"><h3>{origin.recovery.action==='supersede'?'Como foi encerrado':'Como foi retomado'}</h3><p>{origin.recovery.source}</p><small>{timestamp(origin.recovery.recordedAt)}</small></div>}
        {item.status!=='superseded'&&<dl className="story-facts"><div><dt>O que virou</dt><dd>{bundle?`${bundle.manifest.kind==='skill'?'Skill local':bundle.manifest.kind==='script'?'Script local':'Prática automatizada'} · v${bundle.manifest.capabilityVersion}`:'Pacote não disponível nesta leitura'}</dd></div><div><dt>Quando foi ativada</dt><dd>{bundle?.state.activation?timestamp(bundle.state.activation.recordedAt):bundle?'Sem ativação registrada':'Ativação não verificada'}</dd></div><div><dt>Já foi usada?</dt><dd>{usageAvailable?usage!.executions?`${usage!.executions} chamada${usage!.executions===1?'':'s'} registrada${usage!.executions===1?'':'s'}`:'Nenhuma chamada registrada':'Uso ainda não verificado'}</dd>{usageAvailable&&usage!.executions>0&&<small>{usage!.passed} com sucesso · {usage!.failed} com falha</small>}</div></dl>}
        {origin?.lastError&&!['active','superseded'].includes(item.status)&&<div className="story-warning"><strong>O que impediu o avanço</strong><p>{origin.lastError}</p><span>{origin.attempts} tentativa(s) · última atualização {timestamp(origin.updatedAt)}</span></div>}
        <details className="story-details"><summary>Ver histórico e evidências</summary>
          {item.status==='superseded'&&origin?.lastError&&<p>Falha preservada no histórico: {origin.lastError}</p>}
          {origin?.recovery?.successorId&&<p>Caso que substituiu este registro: <CopyId value={origin.recovery.successorId} {...copy}/></p>}
          {reason&&<p className="receipt-text">{reason}</p>}
          <ol className="story-timeline">
            {origin&&<li><strong>Aprendizado identificado</strong><span>{timestamp(origin.createdAt)}</span></li>}
            {bundle&&<li><strong>Pacote gerado</strong><span>{timestamp(bundle.manifest.createdAt)} · {bundle.manifest.testCount} testes incluídos</span></li>}
            {bundle?.state.validation&&<li><strong>Validação registrada</strong><CopyId value={bundle.state.validation.path} {...copy}/></li>}
            {bundle?.state.activation&&<li><strong>Ativação aprovada pela política local</strong><span>{timestamp(bundle.state.activation.recordedAt)}</span></li>}
            {usage?.runs.map(run=><li key={run.id}><strong>Chamada {run.status==='passed'?'concluída':'com falha'} · {duration(run.durationMs)}</strong><span>{timestamp(run.recordedAt)} · {run.entrypoint}</span><CopyId value={run.artifactPath} {...copy}/></li>)}
            {bundle?.state.disabled&&<li><strong>Desativada</strong><span>{timestamp(bundle.state.disabled.recordedAt)}</span></li>}
          </ol>
          <p className="muted">Uso conta chamadas verificadas no inventário de recibos, sem limite de período nesta tela. Uma chamada não comprova aplicação do resultado em um produto nem economia de tempo ou tokens.</p>
          {data.runtimeEffects?.state==='partial'&&<p className="warning-text">A leitura de uso está incompleta; as contagens cobrem somente os recibos verificados.</p>}
          {bundle&&<><h3>Versão exata</h3><CopyId value={bundle.manifest.hash} {...copy}/><p className="muted">Para desativar esta versão, peça ao agente usando este hash.</p></>}
          {origin?.jobIds.map(id=><button className="subtle-link" type="button" key={id} onClick={()=>onOpenRun(id)}>Abrir tentativa {id.slice(0,8)}</button>)}
          {[...new Set([origin?.artifactPath,...(origin?.evidence??[]),bundle?.manifest.artifactPath].filter((ref):ref is string=>Boolean(ref)))].map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}
        </details>
      </article>;
    })}</div>
    {complete&&!visible.length&&<EmptyState title="Nenhum aprendizado nesta etapa" detail="Escolha outra etapa ou outro projeto para consultar os registros."/>}
  </>;
}
