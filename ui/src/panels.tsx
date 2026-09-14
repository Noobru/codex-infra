import {useState} from 'react';
import {Activity,ArrowUpRight,Clipboard,Database,FileCheck2,Layers3,LockKeyhole,RefreshCw,ShieldCheck,Sparkles,TerminalSquare,Zap} from 'lucide-react';
import type {DashboardObservation,DashboardOptions} from './api';
import {EfficiencyHistory,type HistoryDays,type HistorySelection} from './EfficiencyHistory';
import {ImprovementEffects} from './ImprovementEffects';
import {LearningStories} from './LearningCapabilities';
import {LearningRuntimeEffectsView} from './LearningRuntimeEffects';
import type {EvaluationComparison,EvaluationReceipt} from '../../src/evaluation';
import {CopyId,EmptyState,InfoCard,MetricCard,ScopeNote,SectionHeading,timestamp,type CopyProps} from './components';

type PanelProps={data:DashboardObservation;onOpenRun:(id:string)=>void}&CopyProps;
type InteractionSelection=Pick<DashboardOptions,'interactionOffset'|'interactionLimit'|'interactionStatus'>;
export function InteractionsView({data,onOpenRun,selection,onChange,pending,...copy}:PanelProps&{
  selection:InteractionSelection;onChange:(value:InteractionSelection)=>void;pending:boolean;
}){
  const source=data.operations.data?.interactions;
  return <>
    <SectionHeading label="Interaction records" title="Conversations and direct work" count={source?`${source.total} in this scope`:'unavailable'}/>
    <ScopeNote>Direct is a conversation or work record, not a worker execution. Imported means metadata was observed, not that work started or finished. Execution evidence belongs to linked runs. The project filter applies here; run search and run state do not.</ScopeNote>
    <div className="pagination" aria-label="Interaction filters">
      <label className="select-wrap"><span>Interaction status</span><select aria-label="Interaction status" value={selection.interactionStatus??'all'} onChange={event=>onChange({...selection,interactionOffset:0,interactionStatus:event.target.value==='all'?undefined:event.target.value as DashboardOptions['interactionStatus']})}><option value="all">All interaction states</option>{['imported','open','completed','blocked','cancelled'].map(status=><option key={status} value={status}>{status}</option>)}</select></label>
      <label className="select-wrap"><span>Per page</span><select aria-label="Interactions per page" value={selection.interactionLimit??50} onChange={event=>onChange({...selection,interactionOffset:0,interactionLimit:Number(event.target.value)})}><option value={50}>50</option><option value={100}>100</option></select></label>
    </div>
    {source?.items.map(item=><details className="receipt-details" key={item.id}>
      <summary>{item.title??'Title not provided'} · {item.status} · {item.route}</summary>
      <div className="card-list"><span>Project: {item.projectId??'no project assigned'} · intent: {item.intent} · revision {item.revision}</span><span>Updated: {timestamp(item.updatedAt)} · source: {item.change.origin.source}</span>{item.titleTruncated&&<span>Title shortened from {item.titleOriginalChars.toLocaleString()} characters.</span>}{item.objective&&<span>Objective: {item.objective}</span>}{item.summary&&<span>Summary: {item.summary}</span>}</div>
      <div className="hash-line"><span>Interaction</span><CopyId value={item.id} {...copy}/></div>
      {item.threadId&&<div className="hash-line"><span>Thread</span><CopyId value={item.threadId} {...copy}/></div>}
      {item.imported&&<div className="card-list"><span>Imported source state: {item.imported.sourceStatus} · observed {timestamp(item.imported.origin.observedAt)}</span><span>Source update: {timestamp(item.imported.updatedAt)} · {item.imported.origin.source}</span>{item.imported.origin.sourceRef&&<span>Source reference: {item.imported.origin.sourceRef}</span>}</div>}
      {!!item.jobIds.length&&<div className="card-list">{item.jobIds.map(id=><button className="subtle-link" type="button" key={id} onClick={()=>onOpenRun(id)}>Inspect linked run {id.slice(0,8)}<ArrowUpRight size={15}/></button>)}</div>}
      {!!item.workflowIds.length&&<div className="card-list">{item.workflowIds.map(id=><div className="hash-line" key={id}><span>Workflow</span><CopyId value={id} {...copy}/></div>)}</div>}
      <div className="hash-line"><span>Record</span><CopyId value={item.artifactPath} {...copy}/></div>
      {!!item.findings?.length&&<details className="receipt-details"><summary>Recorded findings ({item.findings.length})</summary>{item.findings.map(finding=><div className="measurement-record" key={finding.id}><strong>{finding.title}</strong><span>{finding.kind} · {finding.projectId} · recorded in interaction revision {finding.recordedRevision}</span><span style={{whiteSpace:'pre-wrap'}}>{finding.content}</span><div className="hash-line"><span>Origin interaction</span><CopyId value={item.id} {...copy}/></div>{finding.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}</div>)}</details>}
      {item.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}
    </details>)}
    {!source?.items.length&&<EmptyState title={source?'No interactions match this scope':'Interaction source unavailable'} detail={source?'Choose another interaction status or project scope.':'Use Refresh to retry reading the interaction records.'}/>}
    {source&&<div className="pagination" aria-label="Interaction pagination"><span>{source.total===0?'No interaction records':`Interactions ${source.offset+1}–${source.offset+source.items.length} of ${source.total}`}</span><button className="refresh-button" type="button" disabled={pending||source.offset===0} onClick={()=>onChange({...selection,interactionOffset:Math.max(0,source.offset-source.limit)})}>Previous interactions</button><button className="refresh-button" type="button" disabled={pending||source.nextOffset===null} onClick={()=>onChange({...selection,interactionOffset:source.nextOffset!})}>Next interactions</button></div>}
  </>;
}
export function OperationsSummary({data,onOpenRun,...copy}:PanelProps){
  const ops=data.operations.data;
  return <><SectionHeading label="Execution capacity" title="Workers and coordinated plans" count={data.operations.state}/>
    <section className="evidence-summary-grid"><MetricCard label="Worker limit" value={String(ops?.policy?.maxWorkers??'unknown')} note="shared installation policy" tone="cyan" icon={Layers3}/><MetricCard label="Model limit" value={String(ops?.policy?.maxModelWorkers??'unknown')} note="within worker capacity" tone="neutral" icon={Zap}/><MetricCard label="Active owners" value={ops?.activeWorkers?String(ops.activeWorkers.length):'unknown'} note="selected project scope" tone="green" icon={Activity}/><MetricCard label="Saved plans" value={ops?.workflows?String(ops.workflows.length):'unknown'} note="bounded workflow inventory" tone="neutral" icon={Clipboard}/></section>
    {ops?.activeWorkers?.map(worker=><button className="subtle-link" key={worker.id} onClick={()=>onOpenRun(worker.id)}>{worker.projectId} · {worker.executionKind} · {worker.status} · attempt {worker.attempts}<ArrowUpRight size={15}/></button>)}
    {!!ops?.workflows?.length&&<details className="receipt-details"><summary>Workflow plans ({ops.workflows.length})</summary><div className="evaluation-list">{ops.workflows.map(plan=><InfoCard key={plan.id} icon={Layers3} title={plan.objective} meta={`Revision ${plan.revision} · ${plan.nodes.every(node=>node.status==='completed')?'completed':plan.state}`}><div className="card-list">{plan.nodes.map(node=><span key={node.id}>{node.jobId?<button className="subtle-link" onClick={()=>onOpenRun(node.jobId!)}>{node.id} · {node.status??'unknown'}<ArrowUpRight size={15}/></button>:`${node.id} · preparing`}</span>)}</div><CopyId value={plan.evidence} {...copy}/></InfoCard>)}</div></details>}
  </>;
}
function ComparisonEvidence({comparison,receipts,baselineJobId,treatmentJobId,onOpenRun,...copy}:CopyProps&{
  comparison:EvaluationComparison;receipts:EvaluationReceipt[];baselineJobId?:string;treatmentJobId?:string;onOpenRun:(id:string)=>void;
}){
  const singleObservation=comparison.baseline?.sample?.size===1||comparison.treatment?.sample?.size===1;
  const origins=[
    {label:'Baseline',id:comparison.baselineId,jobId:baselineJobId??receipts.find(item=>item.id===comparison.baselineId)?.jobId},
    {label:'Treatment',id:comparison.treatmentId,jobId:treatmentJobId??receipts.find(item=>item.id===comparison.treatmentId)?.jobId},
  ];
  return <>
    <div className="measurement-record"><span>Baseline: {comparison.baseline?.value?.toLocaleString()??'not recorded'} {comparison.baseline?.unit??''} → Treatment: {comparison.treatment?.value?.toLocaleString()??'not recorded'} {comparison.treatment?.unit??''}</span><strong>Difference: {comparison.absoluteDelta==null?'not established':`${comparison.absoluteDelta>0?'+':''}${comparison.absoluteDelta.toLocaleString()} ${comparison.baseline?.unit??''}`}</strong><span>{singleObservation?'One observed execution per receipt':comparison.reason}</span></div>
    <details className="receipt-details"><summary>Comparison method</summary><div className="card-list"><span>{comparison.reason}</span><span>Percentage: {comparison.percentageChange==null?'not established':`${comparison.percentageChange.toFixed(2)}%`} · {comparison.percentageReason}</span>{comparison.limitations.map((text,index)=><span key={index}>{text}</span>)}</div></details>
    {origins.map(origin=><div className="card-list" key={origin.label}><div className="hash-line"><span>{origin.label} evaluation</span><CopyId value={origin.id} {...copy}/></div>{origin.jobId?<button className="subtle-link" type="button" onClick={()=>onOpenRun(origin.jobId!)}>Inspect {origin.label.toLowerCase()} run {origin.jobId.slice(0,8)}<ArrowUpRight size={15}/></button>:<span>Run link not available in these receipts.</span>}</div>)}
  </>;
}
export function EfficiencyView({data,onOpenRun,onCompare,onPage,selection,historyDays,onDaysChange,historySelection,onHistorySelectionChange,pending,...copy}:PanelProps&{onCompare:(value:DashboardOptions['comparison'])=>void;onPage:(offset:number)=>void;selection:DashboardOptions['comparison'];historyDays:HistoryDays;onDaysChange:(days:HistoryDays)=>void;historySelection:HistorySelection;onHistorySelectionChange:(selection:HistorySelection)=>void;pending:boolean}){
  const [baseline,setBaseline]=useState(selection?.baselineId??''),[treatment,setTreatment]=useState(selection?.treatmentId??''),[metric,setMetric]=useState(selection?.metricId??'');
  const receipts=data.evaluations.data;
  const items=receipts?.items??[];
  const automatic=data.insights?.data?.comparisons??[];
  const automaticSourceAvailable=Boolean(data.insights?.data);
  const metricIds=[...new Set(items.flatMap(item=>item.metrics.map(value=>value.id)))];
  const comparison=data.comparison?.data;
  const automaticCards=automatic.map(item=><InfoCard key={item.id} icon={Zap} title={item.metricLabel} meta={item.projectId+' · '+item.comparison.status}>
      <ComparisonEvidence comparison={item.comparison} receipts={items} baselineJobId={item.baselineJobId} treatmentJobId={item.treatmentJobId} onOpenRun={onOpenRun} {...copy}/>
      {!!item.evidence.length&&<details className="receipt-details"><summary>Comparison evidence ({item.evidence.length})</summary>{item.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}</details>}
    </InfoCard>);
  return <>
    <section className="answer-panel"><span className="eyebrow">Como ler esta tela</span><h2>{data.runtimeEffects?.data?.tokenComparison.status==='observed'?'Há trabalhos equivalentes para comparar':'Aguardando evidência para comparar melhorias'}</h2><p>Eficiência reúne consumo de tokens, duração e resultados. As capacidades abaixo mostram o uso registrado e o que falta para comparar turnos do mesmo projeto, escopo, modelo e esforço. Uma diferença observada não comprova economia causada pela melhoria.</p></section>
    <details className="disclosure-panel"><summary>Entenda as medidas de eficiência</summary><div className="definition-grid"><article><h3>Consumo de tokens</h3><p>Quanto o modelo processou por turno ou por dia. Um total menor pode refletir menos trabalho; sozinho, não comprova melhoria.</p></article><article><h3>Resultado das execuções</h3><p>Conclusões, falhas e tentativas adicionais. Compare trabalhos equivalentes para interpretar a mudança.</p></article><article><h3>Tempo registrado</h3><p>Duração dos checks ou tempo decorrido de um ciclo. Tempo decorrido também inclui esperas; não representa horas poupadas.</p></article></div></details>
    <EfficiencyHistory history={data.history?.data} days={historyDays} onDaysChange={onDaysChange} selection={historySelection} onSelectionChange={onHistorySelectionChange} pending={pending} error={data.history?.state==='unavailable'?'History could not be read. Refresh to retry.':undefined} onOpenRun={onOpenRun} {...copy}/>
    <details className="disclosure-panel"><summary>Chamadas de capacidades no período</summary><LearningRuntimeEffectsView source={data.runtimeEffects} {...copy}/></details>
    <details className="disclosure-panel"><summary>Promoções de contexto do fluxo anterior</summary><ImprovementEffects source={data.improvements} tokenEffects={data.learningEffects} onOpenRun={onOpenRun} {...copy}/></details>
    <details className="disclosure-panel"><summary>Comparações de checks e avaliações detalhadas</summary>
    <SectionHeading label="Evaluation receipts" title="Automatic comparisons" count={data.insights?.data?String(automatic.length):data.insights?.state??'unavailable'}/>
    <ScopeNote>The four most recent compatible comparisons appear first. These are observed check durations; details and earlier comparisons remain available below.</ScopeNote>
    <div className="evaluation-list">{automaticCards.slice(0,4)}</div>
    {automatic.length>4&&<details className="receipt-details"><summary>Earlier automatic comparisons ({automatic.length-4})</summary><div className="evaluation-list">{automaticCards.slice(4)}</div></details>}
    {!automatic.length&&<EmptyState title={automaticSourceAvailable?'No compatible comparison in this scope':'Automatic comparisons unavailable'} detail={automaticSourceAvailable?'A pair needs compatible check receipts and passing critical gates. A single observation does not establish a gain.':'Refresh to retry the recorded insights.'}/>}
    <details className="receipt-details"><summary>Choose evaluations manually</summary>
      <form className="comparison-form" onSubmit={event=>{event.preventDefault();onCompare({baselineId:baseline,treatmentId:treatment,metricId:metric});}}>
        <label>Baseline<select aria-label="Baseline evaluation" required value={baseline} onChange={e=>setBaseline(e.target.value)}><option value="">Choose evaluation</option>{items.map(item=><option key={item.id} value={item.id}>{item.projectId} · {item.jobId.slice(0,8)} / attempt {item.attempt} · {item.technical.status}</option>)}</select></label>
        <label>Treatment<select aria-label="Treatment evaluation" required value={treatment} onChange={e=>setTreatment(e.target.value)}><option value="">Choose evaluation</option>{items.map(item=><option key={item.id} value={item.id}>{item.projectId} · {item.jobId.slice(0,8)} / attempt {item.attempt} · {item.technical.status}</option>)}</select></label>
        <label>Metric<select aria-label="Comparison metric" required value={metric} onChange={e=>setMetric(e.target.value)}><option value="">Choose metric</option>{metricIds.map(id=><option key={id}>{id}</option>)}</select></label><button className="refresh-button" type="submit" disabled={!baseline||!treatment||!metric}>Compare receipts</button>
      </form>
      {comparison&&<><ComparisonEvidence comparison={comparison} receipts={items} onOpenRun={onOpenRun} {...copy}/><ScopeNote>{comparison.status} · Accepted delivery comparison: {comparison.acceptedDeliveryComparison?'yes':'not established'}. {comparison.limitations.join(' ')}</ScopeNote></>}
    </details>
    <SectionHeading label="Recorded evaluations" title="Outcomes and measurements" count={receipts?`${items.length} of ${receipts.total} in inspected inventory`:data.evaluations.state}/>
    <div className="evaluation-list">{items.map(item=><InfoCard key={item.id} icon={FileCheck2} title={`${item.projectId} · ${item.taskClass} · attempt ${item.attempt}`} meta={`${item.technical.status} / critical ${item.technical.criticalGateStatus}`}>
      <div className="card-list"><span>{timestamp(item.recordedAt)} · run {item.jobId.slice(0,8)}</span><span>Rubric {item.rubric.id} / {item.rubric.version}</span><span>Owner acceptance: {item.acceptance.status}</span><span>Source: {item.source}</span></div>
      <button className="subtle-link" type="button" onClick={()=>onOpenRun(item.jobId)}>Inspect run {item.jobId.slice(0,8)}<ArrowUpRight size={15}/></button>
      {item.metrics.map(value=><div className="measurement-record" key={value.id}><strong>{value.id}: {value.value??'unknown'} {value.unit??''}</strong><span>{value.classification} · {value.method??'method unknown'} · version {value.version??'unknown'}</span><span>Cohort: {value.cohort??'unknown'} · sample N={value.sample?.size??'?'} · {value.sample?.representative?'declared representative':'not representative / unknown'}</span><span>Window: {timestamp(value.window?.start)} → {timestamp(value.window?.end)}</span><span>Source: {value.source??'unknown'}</span>{value.sample&&<span>Selection: {value.sample.selection}</span>}{value.classification==='estimated'&&<span>Estimate basis: {value.estimateBasis}</span>}{value.classification==='unknown'&&<span>{value.reason}</span>}</div>)}
      <div className="hash-line"><CopyId value={item.artifactPath} {...copy}/></div>
    </InfoCard>)}</div>
    {!items.length&&<EmptyState title={data.evaluations.state==='unavailable'?'Evaluation source unavailable':'No evaluations recorded in this scope'} detail={data.evaluations.state==='unavailable'?'Refresh to retry reading evaluation receipts.':'Completed checks produce automatic evaluations when their receipts and named-check contract are available. Owner acceptance remains separate.'}/>}
    {receipts&&<div className="pagination"><span>{receipts.truncated?'Inventory limited to 500 recent receipts.':'Inventory read from owned evaluation receipts.'}</span><button className="refresh-button" disabled={receipts.offset===0} onClick={()=>onPage(Math.max(0,receipts.offset-receipts.limit))}>Previous evaluations</button><button className="refresh-button" disabled={receipts.nextOffset===null} onClick={()=>onPage(receipts.nextOffset!)}>Next evaluations</button></div>}
    </details>
  </>;
}

export function ProjectView({data,onChoose,onOpenRun}: {data:DashboardObservation;onChoose:(id:string)=>void;onOpenRun:(id:string)=>void}){
  const roots=data.projects.items.filter(project=>!project.parentProjectId);
  const [selectedProject,setSelectedProject]=useState(data.overview.projectId??'codex-infra');
  const [projectSearch,setProjectSearch]=useState('');
  const choices=roots.filter(project=>project.name.toLocaleLowerCase('pt-BR').includes(projectSearch.toLocaleLowerCase('pt-BR')));
  const selected=choices.find(project=>project.id===selectedProject)??choices[0];
  const projects=selected?[selected]:[];
  return <><div className="reading-intro"><p>Atividade acompanhada pela Infra em cada projeto.</p><p className="muted">Ambientes de teste e de geração de aprendizado ficam dentro de CodexInfra. Conclusão técnica de uma execução não equivale ao aceite do produto.</p></div>
    <div className="project-browser"><nav className="project-index" aria-label="Projetos cadastrados"><label>Buscar projeto<input value={projectSearch} onChange={event=>setProjectSearch(event.target.value)} placeholder="Nome do projeto"/></label>{choices.map(project=><button type="button" key={project.id} aria-pressed={selected?.id===project.id} onClick={()=>setSelectedProject(project.id)}><strong>{project.name}</strong><span>{project.activity.active?`${project.activity.active} execuções ativas`:'Sem execuções ativas'}</span></button>)}</nav>
    <section className="project-grid">{projects.map(project=><article className="project-card" key={project.id}>
      <div className="project-card-top"><h2>{project.name}</h2><span className="class-pill">{project.population==='fixture'?'Teste':project.population==='learning'?'Aprendizado':project.population==='unclassified'?'Sem classificação':'Projeto'}</span></div>
      <p className="muted">{project.activity.active?`${project.activity.active} execução(ões) em andamento ou na fila.`:project.activity.total?'Sem execuções ativas neste momento.':'Nenhuma execução registrada pela Infra.'}</p>
      <div className="project-stats"><div><span>Execuções diretas</span><strong>{project.activity.total}</strong></div><div><span>Concluídas</span><strong>{project.activity.completed}</strong></div></div>
      <p className="muted">Última atividade: {project.activity.updatedAt?timestamp(project.activity.updatedAt):'não registrada'}</p>
      <div className="project-actions"><button className="subtle-link" type="button" onClick={()=>onChoose(project.id)}>Ver trabalho do projeto<ArrowUpRight size={15}/></button>{project.activity.latestId&&<button className="subtle-link" type="button" onClick={()=>onOpenRun(project.activity.latestId!)}>Última execução<ArrowUpRight size={15}/></button>}</div>
      {data.projects.items.some(child=>child.parentProjectId===project.id)&&<details className="story-details project-children"><summary>Ambientes internos ({data.projects.items.filter(child=>child.parentProjectId===project.id).length})</summary><p className="muted">Testes e trabalhos de aprendizado pertencentes a este projeto. Cada ambiente preserva suas execuções para investigação.</p><div className="activity-list">{data.projects.items.filter(child=>child.parentProjectId===project.id).map(child=><div className="activity-row" key={child.id}><div><strong>{child.name}</strong><p>{child.population==='fixture'?'Teste da Infra':'Geração de aprendizado'} · {child.activity.total} execuções · {child.activity.active} ativas · {timestamp(child.activity.updatedAt)}</p><details><summary>Identificação do ambiente</summary><p className="muted">{child.registeredName}</p><code>{child.id}</code></details></div><button type="button" className="subtle-link" onClick={()=>onChoose(child.id)}>Ver execuções</button></div>)}</div></details>}
      <details className="story-details"><summary>Cadastro técnico</summary><p className="muted">{project.id} · cadastro {project.status}</p><p className="muted">Stack: {project.stack.join(', ')||'não informada'}. {project.sourceCount} fontes de contexto · {project.checks.length} checks configurados.</p></details>
    </article>)}</section>
    </div>
    {!projects.length&&<EmptyState title={data.projects.state==='unavailable'?'Cadastro indisponível':'Nenhum projeto neste recorte'} detail="Altere o filtro ou atualize a leitura."/>}
  </>;
}

export function EvidenceRecoveryView({data,...copy}:Omit<PanelProps,'onOpenRun'>){
  const recovery=data.recovery?.data;
  const latest=recovery?.verifications.slice().sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt))[0];
  return <>
    <section className="answer-panel"><span className="eyebrow">Recuperação da instalação · todos os projetos</span><h2>{latest?'Existe um teste de recuperação registrado':recovery?'Ainda não há teste de recuperação registrado':'Não foi possível consultar a recuperação'}</h2><p>{latest?`O teste mais recente disponível é de ${timestamp(latest.capturedAt)}. Ele documenta uma recuperação feita naquela data. A possibilidade de recuperar a instalação atual ainda precisa de uma verificação atual.`:'Um manifesto de backup sozinho não comprova que a restauração funciona.'}</p></section>
    {latest&&<article className="learning-story"><header className="story-heading"><h2>O que o último teste comprovou</h2><span className="story-status">Evidência histórica</span></header><dl className="story-facts"><div><dt>Arquivos recuperados</dt><dd>{latest.files}</dd></div><div><dt>Jobs recuperados</dt><dd>{latest.recoveredJobs}</dd></div><div><dt>Estado original preservado</dt><dd>{latest.sourceStatePreserved?'Sim, conforme o recibo':'Não confirmado'}</dd></div></dl><details className="story-details"><summary>Abrir a prova deste teste</summary><CopyId value={latest.evidence} {...copy}/><p className="muted">Manifesto verificado</p><CopyId value={latest.manifestSha256} {...copy}/></details></article>}
    {recovery?.truncated&&<ScopeNote>O inventário atingiu o limite de leitura; este resumo cobre os registros disponíveis.</ScopeNote>}
    <EvidenceRecoveryLedger data={data} {...copy}/>
  </>;
}

function EvidenceRecoveryLedger({data,...copy}:Omit<PanelProps,'onOpenRun'>){
  const run=data.run?.data, recovery=data.recovery?.data;
  return <><details className="disclosure-panel"><summary>Histórico de recuperação e manifestos</summary>
      <SectionHeading label="Recovery ledger" title="Restoration evidence" count={data.recovery?.state??'unavailable'}/>
      <div className="evaluation-list">{recovery?.verifications.map(item=><InfoCard key={item.evidence} icon={RefreshCw} title={`Recovery verified ${timestamp(item.capturedAt)}`} meta={`${item.files} files · ${item.recoveredJobs} recovered jobs`}><div className="card-list"><span>Source state preserved: {String(item.sourceStatePreserved)} · own CLI: {String(item.copyUsesOwnCli)}</span><span>UI build: {item.uiBuild?.status??'not recorded'}</span><span>Activated scope: {item.activationValidation?.activatedProjectIds.join(', ')??'not recorded'}</span><span>Product checks executed: {item.activationValidation?String(item.activationValidation.externalProjectChecksExecuted):'unknown'}</span><span>Restored verification job: {item.restoredJobId}</span></div><div className="hash-line"><span>Manifest</span><CopyId value={item.manifestSha256} {...copy}/></div><CopyId value={item.evidence} {...copy}/></InfoCard>)}</div>
      {!recovery?.verifications.length&&<EmptyState title="No compatible recovery verification observed" detail="Backup metadata alone does not prove restoration. Refresh to retry an unavailable source."/>}
      <details className="receipt-details"><summary>Backup manifests ({recovery?.snapshots.length??'unknown'})</summary>{recovery?.snapshots.map(item=><div className="measurement-record" key={item.name}><strong>{item.name}</strong><span>{timestamp(item.createdAt)} · {item.files} files · {item.bytes.toLocaleString()} bytes</span><CopyId value={item.manifestSha256} {...copy}/><CopyId value={item.evidence} {...copy}/></div>)}</details>
      <ScopeNote>{recovery?.limitations.join(' ')??'Recovery metadata unavailable.'} {recovery?.truncated?'The inventory is bounded to 20 entries per source.':''}</ScopeNote>
      </details><details className="disclosure-panel"><summary>Recibos de integrações de segurança</summary>
      <SectionHeading label="Security integrations" title="Feeds and publication receipts" count={data.operations.data?.security?String(data.operations.data.security.length):'unavailable'}/>
      <div className="evaluation-list">{data.operations.data?.security?.map(receipt=><InfoCard key={receipt.receiptId} icon={ShieldCheck} title={`${receipt.projectId} · ${receipt.decision}`} meta={`${receipt.stage} · exit ${receipt.effectiveExit??'unknown'}`}><div className="card-list"><span>Feeds: {receipt.feedStatus??'not requested'}</span><span>Publication: {receipt.publicationStatus??'not recorded'}</span></div>{receipt.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}</InfoCard>)}</div>
      {!data.operations.data?.security?.length&&<EmptyState title="No security receipts in this scope" detail="Evaluate a registered report through the CLI or MCP to record the effective gate and feed provenance."/>}
      </details><details className="disclosure-panel"><summary>Evidências da execução selecionada</summary><p className="muted">{run?.summary.objectiveExcerpt??'Escolha uma execução pela Visão geral para consultar suas evidências.'}</p>
      <SectionHeading label="Selected run" title="Receipt references and cleanup" count={run?run.summary.id:'none selected'}/>
      {run?<><section className="panel evidence-reference-list">{run.evidence.map(ref=><div className="evidence-reference" key={ref}><FileCheck2 size={16}/><CopyId value={ref} {...copy}/></div>)}</section><section className="panel"><table className="runs-table"><thead><tr><th>Attempt</th><th>Model worker</th><th>Cleanup</th><th>Worker finished</th></tr></thead><tbody>{run.attempts.map(attempt=>{
        const checksOnly=(attempt.taskContract?.kind??run.prepared.kind)==='checks'&&!attempt.worker;
        const checksConfirmed=checksOnly&&Boolean(attempt.checks?.length)&&!attempt.checksTruncated&&attempt.checks!.every(check=>check.exitCode!==null&&check.cleanupFailed===false);
        const cleanup=attempt.worker?.cleanupConfirmed!=null?(attempt.worker.cleanupConfirmed?'confirmed in worker receipt':'not confirmed')
          :checksConfirmed?'confirmed in check receipts':attempt.checks?.some(check=>check.cleanupFailed)?'not confirmed':'not established';
        return <tr key={attempt.attempt}><td>{attempt.attempt}</td><td>{checksOnly?'Not applicable':attempt.worker?.status??'unknown'}</td><td>{cleanup}</td><td>{checksOnly?'Not applicable':timestamp(attempt.worker?.finishedAt)}</td></tr>;
      })}</tbody></table></section></>:<EmptyState title="No run evidence selected" detail="Select a recorded run to inspect its receipts. Global recovery evidence remains available above."/>}
      <ScopeNote>References can be copied for local inspection. Full logs and arbitrary file contents are not served. Cleanup, restore and owner acceptance are separate observations.</ScopeNote>
    </details></>;
}

export function LearningQueueView({data,onOpenRun,...copy}:PanelProps){
  const learning=data.learning,ledger=data.operations.data?.learning,signals=data.insights?.data?.signals??[];
  const signalCount=signals.length+(learning?.signals.length??0),hasSignals=signalCount>0;
  const signalsUnavailable=!data.insights?.data||!learning||['partial','unavailable'].includes(learning.signalsState);
  return <><LearningStories data={data} onOpenRun={onOpenRun} {...copy}/>
    <details className="disclosure-panel"><summary>Arquivo de candidatos e sinais de origem</summary><p className="muted">Registros anteriores e sinais brutos. Um candidato neste arquivo pode já ter uma versão ativa na lista acima.</p>
    <SectionHeading label="Learning ledger" title="Candidates and decisions"/>
    <div className="evaluation-list">{ledger?.map(item=><InfoCard key={item.id} icon={Clipboard} title={item.title} meta={item.projectId+' · '+item.kind+' · '+item.status}>
      <div className="card-list">{item.contentExcerpt&&<p>{item.contentExcerpt}</p>}<span>Source: {item.source}</span><span>Review: {item.review??'not recorded'} · shadow: {item.shadow??'not recorded'}</span></div>
      {item.originJobId&&<button className="subtle-link" type="button" onClick={()=>onOpenRun(item.originJobId!)}>Inspect origin run<ArrowUpRight size={15}/></button>}
      {item.originInteractionId&&<><div className="hash-line"><span>Origin interaction · revision {item.originInteractionRevision}</span><CopyId value={item.originInteractionId} {...copy}/></div></>}
      {item.promotionPath&&<div className="hash-line"><span>Release</span><CopyId value={item.promotionPath} {...copy}/></div>}
      <details className="receipt-details"><summary>Candidate evidence ({item.evidence.length})</summary>{item.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}</details>
    </InfoCard>)}</div>
    {!ledger?.length&&<EmptyState title={ledger?'No learning candidates in this scope':'Learning ledger unavailable'} detail={ledger?'Recorded findings and supported recurring failures supply candidate evidence. Executable bundles have their own review and activation records above.':'Refresh to retry reading candidate records.'}/>}
    {!!learning?.candidates?.length&&<details className="receipt-details"><summary>Candidate references in project registry ({learning.candidates.length})</summary>{learning.candidates.map((item,i)=><InfoCard key={i} icon={Clipboard} title={item.label} meta={item.projectId+' · '+item.status}><CopyId value={item.evidence} {...copy}/></InfoCard>)}</details>}
    <SectionHeading label="Observed signals" title="Evidence to review" count={hasSignals?String(signalCount):signalsUnavailable?'unavailable':'0'}/>
    <div className="evaluation-list">{signals.map(item=><InfoCard key={item.id} icon={TerminalSquare} title={item.reason} meta={item.kind+' · '+item.projectId}>
      <div className="card-list"><span>Attempts: {item.attempts.join(' → ')}</span></div>
      <button className="subtle-link" type="button" onClick={()=>onOpenRun(item.jobId)}>Inspect source run {item.jobId.slice(0,8)}<ArrowUpRight size={15}/></button>
      <details className="receipt-details"><summary>Signal evidence ({item.evidence.length})</summary>{item.evidence.map(ref=><div className="hash-line" key={ref}><CopyId value={ref} {...copy}/></div>)}</details>
    </InfoCard>)}{learning?.signals.map((item,i)=><InfoCard key={item.kind+'-'+item.projectId+'-'+i} icon={TerminalSquare} title={item.reason} meta={item.kind+' · '+item.projectId}><CopyId value={item.evidence} {...copy}/>{item.jobId&&<button className="subtle-link" type="button" onClick={()=>onOpenRun(item.jobId!)}>Inspect source run<ArrowUpRight size={15}/></button>}</InfoCard>)}</div>
    {!hasSignals&&<EmptyState title={signalsUnavailable?'Signal inventory unavailable or incomplete':'No failure or recovery signals observed'} detail={signalsUnavailable?'Refresh to retry reading recorded insights.':'Signals describe recorded outcomes; they do not establish a cause or promote a reusable practice.'}/>}
    </details>
  </>;
}
