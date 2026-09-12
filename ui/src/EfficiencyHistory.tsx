import {useId, useState} from 'react';
import {Activity, ArrowUpRight, GitBranch} from 'lucide-react';
import type {EfficiencyHistoryResult, TokenHistoryMetric} from '../../src/efficiency-history';
import {CopyId, EmptyState, InfoCard, numbers, timestamp, type CopyProps} from './components';
import './efficiency-history.css';

export type HistoryDays = 7 | 14 | 30 | 90;
export type EfficiencyHistoryProps = CopyProps & {
  history: EfficiencyHistoryResult | null | undefined;
  onDaysChange: (days: HistoryDays) => void;
  onOpenRun: (jobId: string) => void;
  selection: HistorySelection;
  onSelectionChange: (selection: HistorySelection) => void;
  pending?: boolean;
  days?: HistoryDays;
  error?: string;
};

type Source = 'tokens' | 'checks' | 'codex' | 'direct';
type Metric = 'firstPassRate' | 'failedRate' | 'retries' | 'completed' | 'duration' | 'cycles' | 'wallClock' | TokenHistoryMetric;
export type HistorySelection = {source: Source; metric: Metric; seriesId: string; tokenSeriesId: string; tokenAggregation: 'mean' | 'total'};
export const initialHistorySelection: HistorySelection = {source: 'tokens', metric: 'totalTokens', seriesId: '', tokenSeriesId: '', tokenAggregation: 'mean'};
type PlotPoint = {day: string; value: number | null; n: number; jobIds: string[]; evidence: string[]; interactionIds?: string[]; turnIds?: string[]};
type Change = EfficiencyHistoryResult['changes'][number];
const periods: HistoryDays[] = [7, 14, 30, 90];
const sources: {id: Source; label: string}[] = [
  {id: 'tokens', label: 'Token usage · measured'},
  {id: 'checks', label: 'Check jobs'}, {id: 'codex', label: 'Codex jobs'}, {id: 'direct', label: 'Direct work · declared'},
];
const metrics: Record<Metric, {label: string; unit: string}> = {
  firstPassRate: {label: 'Completed on first attempt', unit: '% of finished jobs'},
  failedRate: {label: 'Failed jobs', unit: '% of finished jobs'},
  retries: {label: 'Additional attempts', unit: 'attempts'},
  completed: {label: 'Completed jobs', unit: 'jobs'},
  duration: {label: 'Check duration · compatible cohort', unit: 'ms'},
  cycles: {label: 'Completed work cycles', unit: 'declared cycles'},
  wallClock: {label: 'Elapsed cycle time', unit: 'ms · declared wall-clock'},
  totalTokens: {label: 'Total tokens', unit: 'tokens'},
  inputTokens: {label: 'Input tokens', unit: 'tokens'},
  uncachedInputTokens: {label: 'Uncached input tokens', unit: 'tokens'},
  cachedInputTokens: {label: 'Cached input tokens', unit: 'tokens'},
  outputTokens: {label: 'Output tokens', unit: 'tokens'},
  reasoningOutputTokens: {label: 'Reasoning output tokens', unit: 'tokens'},
  cacheWriteInputTokens: {label: 'Cache-write input tokens', unit: 'tokens'},
};
const tokenMetrics: TokenHistoryMetric[] = ['totalTokens', 'inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens'];
const dayLabel = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});

/** Read-only presentation of the shared history projection; missing samples remain gaps. */
export function EfficiencyHistory({history, onDaysChange, onOpenRun, selection, onSelectionChange, pending = false, days = 14, error, ...copy}: EfficiencyHistoryProps) {
  const chartId = useId();
  const {source, metric, seriesId, tokenSeriesId, tokenAggregation} = selection;
  const [detailSelection, setDetailSelection] = useState<{kind: 'point' | 'change'; id: string} | null>(null);
  const updateSelection = (patch: Partial<HistorySelection>) => {onSelectionChange({...selection, ...patch}); setDetailSelection(null);};
  const seriesOptions = history?.durationSeries.filter(series => series.executionKind === source) ?? [];
  const series = seriesOptions.find(item => item.id === seriesId) ?? seriesOptions[0];
  const tokenSeriesOptions = history?.tokenSeries ?? [];
  const tokenSeries = tokenSeriesOptions.find(item => item.id === tokenSeriesId) ?? tokenSeriesOptions[0];
  const availableMetrics: Metric[] = source === 'tokens' ? tokenMetrics : source === 'direct' ? ['cycles', 'wallClock'] : ['firstPassRate', 'retries', 'failedRate', 'completed', 'duration'];
  const selectedMetric = availableMetrics.includes(metric) ? metric : availableMetrics[0]!;
  const metricInfo = source === 'tokens' ? {...metrics[selectedMetric], unit: tokenAggregation === 'mean' ? 'tokens / complete turn' : 'tokens / day'} : selectedMetric === 'duration' && series ? {label: series.metricLabel, unit: series.unit} : metrics[selectedMetric];
  const points: PlotPoint[] = (history?.points ?? []).map(point => {
    if (source === 'tokens') {
      const tokenMetric = selectedMetric as TokenHistoryMetric;
      const observed = tokenSeries?.points.find(item => item.day === point.day);
      const n = observed?.metricSamples[tokenMetric] ?? 0;
      const total = observed?.[tokenMetric] ?? null;
      return {day: point.day, value: n > 0 && total !== null ? tokenAggregation === 'mean' ? total / n : total : null, n, jobIds: [], evidence: observed?.evidence ?? [], interactionIds: observed?.interactionIds, turnIds: observed?.turnIds};
    }
    if (source === 'direct') {
      const value = selectedMetric === 'wallClock' ? point.direct.elapsedWallClockMsMean : point.direct.completedCycles || null;
      return {day: point.day, value, n: selectedMetric === 'wallClock' ? point.direct.timedCycles : point.direct.completedCycles, jobIds: [], evidence: point.direct.evidence};
    }
    const job = point.jobs[source];
    if (selectedMetric === 'duration') {
      const observed = series?.points.find(item => item.day === point.day);
      return {day: point.day, value: observed?.mean ?? null, n: observed?.n ?? 0, jobIds: [], evidence: observed?.evaluationIds ?? []};
    }
    const observed = job.finished > 0 || job.retries > 0;
    const rate = selectedMetric === 'firstPassRate' ? job.firstPassRate : job.failedRate;
    const value = selectedMetric === 'firstPassRate' || selectedMetric === 'failedRate' ? rate == null ? null : rate * 100
      : observed ? selectedMetric === 'retries' ? job.retries : job.completed : null;
    return {day: point.day, value, n: selectedMetric === 'retries' ? job.jobIds.length : job.finished, jobIds: job.jobIds, evidence: job.evidence};
  });
  const observedPoints = points.filter((point): point is PlotPoint & {value: number} => point.value !== null && Number.isFinite(point.value));
  const first = observedPoints[0];
  const last = observedPoints.at(-1);
  const delta = first && last && first.day !== last.day ? last.value - first.value : null;
  const deltaUnit = selectedMetric === 'firstPassRate' || selectedMetric === 'failedRate' ? 'percentage points' : metricInfo.unit;
  const sampleUnit = source === 'tokens' ? 'complete turns with this counter' : source === 'direct' ? 'declared cycles' : selectedMetric === 'duration' ? 'measured checks' : selectedMetric === 'retries' ? 'recorded jobs' : 'finished jobs';
  const emptyDetail = source === 'tokens' ? history?.telemetry?.enabled === false ? 'Local token telemetry is off.' : (history?.telemetry?.unassignedTurns ?? 0) > 0 ? `${history!.telemetry.unassignedTurns} complete turns lack a recorded project or task scope at turn start.` : 'No complete turns with a declared project and performance scope for this selection.' : selectedMetric === 'duration' ? 'No compatible duration cohort in this period.' : 'A point appears when this source has a recorded sample.';
  const describeScope = (change: Change): {label: string; kind: string | null} => {
    const project = history?.projects.find(item => item.id === change.projectId)?.name ?? change.projectId;
    try {
      const captured = JSON.parse(change.scope);
      if (captured && typeof captured === 'object' && !Array.isArray(captured)) {
        const kind = typeof captured.kind === 'string' ? captured.kind : null;
        const checks = Array.isArray(captured.checkIds) ? captured.checkIds.filter((id: unknown) => typeof id === 'string') : [];
        const fields = [project, kind === 'checks' ? 'Check job' : kind === 'codex' ? 'Codex job' : null,
          typeof captured.taskClass === 'string' ? captured.taskClass : null, typeof captured.language === 'string' ? captured.language : null,
          checks.length ? `Checks: ${checks.join(', ')}` : null];
        return {label: fields.filter(Boolean).join(' · '), kind};
      }
    } catch { /* Earlier markers used project/kind instead of a structured scope. */ }
    const kind = change.scope.startsWith(`${change.projectId}/`) ? change.scope.slice(change.projectId.length + 1).split('/')[0] ?? null : null;
    return {label: [project, kind === 'checks' ? 'Check job' : kind === 'codex' ? 'Codex job' : null].filter(Boolean).join(' · '), kind};
  };
  const changes = (history?.changes ?? []).filter(change => points.some(point => point.day === change.day) && (source !== 'tokens' || !tokenSeries || change.projectId === tokenSeries.projectId));
  const changesByDay = new Map<string, Change[]>();
  for (const change of changes) changesByDay.set(change.day, [...(changesByDay.get(change.day) ?? []), change]);
  const chartChangesByDay = new Map([...changesByDay.entries()].map(([day, items]) => [day, items.filter(change => (source === 'checks' || source === 'codex') && describeScope(change).kind === source)] as const).filter(([, items]) => items.length > 0));
  const selectedChange = detailSelection?.kind === 'change' ? changes.find(change => change.id === detailSelection.id) : undefined;
  const selectedPoint = detailSelection?.kind === 'point' ? points.find(point => point.day === detailSelection.id) : undefined;
  const latestChanges = [...changes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  const plot = {left: 78, right: 858, top: 28, bottom: 226, markerY: 260};
  const x = (index: number) => plot.left + index / Math.max(1, points.length - 1) * (plot.right - plot.left);
  const isRate = selectedMetric === 'firstPassRate' || selectedMetric === 'failedRate';
  const maximum = isRate ? 100 : Math.max(1, ...observedPoints.map(point => point.value)) * 1.12;
  const y = (value: number) => plot.bottom - value / maximum * (plot.bottom - plot.top);
  const segments: string[] = [];
  let segment = '';
  points.forEach((point, index) => {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (segment) segments.push(segment);
      segment = '';
    } else segment += `${segment ? ' L' : 'M'} ${x(index)} ${y(point.value)}`;
  });
  if (segment) segments.push(segment);
  const tickIndexes = [...new Set([0, Math.round((points.length - 1) / 3), Math.round((points.length - 1) * 2 / 3), points.length - 1])].filter(index => index >= 0);
  const showChange = (change: Change) => setDetailSelection({kind: 'change', id: change.id});
  const changeButton = (change: Change) => <button key={change.id} type="button" className={`eh-change ${selectedChange?.id === change.id ? 'eh-selected' : ''}`} onClick={() => showChange(change)} aria-pressed={selectedChange?.id === change.id}>
    <span className="eh-change-date">{dayLabel.format(new Date(`${change.day}T12:00:00Z`))} <span>{change.kind === 'knowledge-use' ? 'context inclusion' : change.kind.replaceAll('-', ' ')}</span></span>
    <strong>{change.label}</strong><span>{describeScope(change).label}</span>
  </button>;

  return <section className="efficiency-history" aria-label="Performance history" aria-busy={pending}>
    <InfoCard icon={Activity} title="Performance history" meta={pending ? 'Updating…' : history ? `Through ${history.window.endDay}` : 'Recorded evidence'}>
      <div className="eh-content">
        <div className="eh-intro"><p>Follow recorded outcomes alongside changes to how work is done.</p><div className="eh-periods" role="group" aria-label="History period">
          {periods.map(period => <button key={period} type="button" aria-pressed={(history?.window.days ?? days) === period} onClick={() => onDaysChange(period)} disabled={pending}>{period} days</button>)}
        </div></div>
        {!history ? <EmptyState title={pending ? 'Loading history' : 'History unavailable'} detail={error ?? 'Recorded history could not be read. No values are inferred.'}/> : <>
          <div className="eh-controls">
            <div className="eh-sources" role="group" aria-label="Evidence source">{sources.map(item => <button key={item.id} type="button" aria-pressed={source === item.id} onClick={() => updateSelection({source: item.id})}>{item.label}</button>)}</div>
            <label className="eh-select">Metric<select value={selectedMetric} onChange={event => updateSelection({metric: event.target.value as Metric})}>{availableMetrics.map(item => <option key={item} value={item}>{metrics[item].label}</option>)}</select></label>
            {source === 'tokens' && <label className="eh-select">Aggregation<select value={tokenAggregation} onChange={event => updateSelection({tokenAggregation: event.target.value as 'mean' | 'total'})}><option value="mean">Average per complete turn</option><option value="total">Daily total</option></select></label>}
            {source === 'tokens' && tokenSeriesOptions.length > 0 && <label className="eh-select eh-cohort">Project and declared work scope<select value={tokenSeries?.id} onChange={event => updateSelection({tokenSeriesId: event.target.value})}>{tokenSeriesOptions.map(item => <option key={item.id} value={item.id}>{[item.projectId, item.performanceScope.taskClass, item.performanceScope.language, item.performanceScope.problemCategory].filter(Boolean).join(' · ')}</option>)}</select></label>}
            {selectedMetric === 'duration' && seriesOptions.length > 0 && <label className="eh-select eh-cohort">Cohort<select value={series?.id} onChange={event => updateSelection({seriesId: event.target.value})}>{seriesOptions.map(item => <option key={item.id} value={item.id}>{item.projectId} · {item.metricLabel} · {item.cohort}</option>)}</select></label>}
          </div>
          <div className="eh-summary" aria-live="polite">
            <div><span className="eh-summary-label">{metricInfo.label}</span><strong>{last ? `${numbers.format(last.value)} ${metricInfo.unit}` : 'No observations yet'}</strong><span>{last ? `Latest observed day: ${last.day} · ${numbers.format(last.n)} ${sampleUnit}` : emptyDetail}</span></div>
            <div><span className="eh-summary-label">Observed change</span><strong>{delta === null ? 'Needs another observed day' : `${delta > 0 ? '+' : ''}${numbers.format(delta)} ${deltaUnit}`}</strong><span>{delta === null ? 'No better / worse conclusion yet.' : `${first!.day} → ${last!.day} · descriptive change`}</span></div>
          </div>
          <div className="eh-chart-scroll">
            <svg className="eh-chart" viewBox="0 0 900 306" role="group" aria-labelledby={`${chartId}-title ${chartId}-description`}>
              <title id={`${chartId}-title`}>{metricInfo.label} over {history.window.days} days</title>
              <desc id={`${chartId}-description`}>{metricInfo.unit}. {observedPoints.length} observed days. Missing days are gaps. Select a point for its sample and evidence, or a diamond for a recorded change. The same data is available in the table below.</desc>
              {[0, maximum / 2, maximum].map(value => <g key={value} aria-hidden="true"><line className="eh-grid" x1={plot.left} x2={plot.right} y1={y(value)} y2={y(value)}/><text className="eh-axis" x={plot.left - 12} y={y(value) + 4} textAnchor="end">{numbers.format(Number(value.toPrecision(3)))}</text></g>)}
              {segments.map((path, index) => <path key={index} d={path} className="eh-line" aria-hidden="true"/>)}
              {points.map((point, index) => point.value !== null && Number.isFinite(point.value) ? <g key={point.day} className={`eh-point ${selectedPoint?.day === point.day ? 'eh-point-selected' : ''}`} role="button" tabIndex={0} aria-label={`${point.day}: ${numbers.format(point.value)} ${metricInfo.unit}, sample ${point.n}. Inspect evidence.`} onClick={() => setDetailSelection({kind: 'point', id: point.day})} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); setDetailSelection({kind: 'point', id: point.day});}}}>
                <circle className="eh-point-hit" cx={x(index)} cy={y(point.value)} r={13}/><circle className="eh-point-dot" cx={x(index)} cy={y(point.value)} r={4.5}/><title>{point.day}: {numbers.format(point.value)} {metricInfo.unit} · sample {point.n}</title>
              </g> : null)}
              {!observedPoints.length && <text x="468" y="126" textAnchor="middle" className="eh-chart-empty">No observed points for this selection</text>}
              <line className="eh-marker-track" x1={plot.left} x2={plot.right} y1={plot.markerY} y2={plot.markerY} aria-hidden="true"/>
              <text className="eh-axis" x={plot.left - 12} y={plot.markerY + 4} textAnchor="end" aria-hidden="true">Changes</text>
              {[...chartChangesByDay.entries()].map(([day, items]) => {
                const index = points.findIndex(point => point.day === day);
                const at = x(index);
                return <g key={day} className="eh-marker" role="button" tabIndex={0} aria-label={`${day}: ${items.length} recorded changes. Inspect changes and evidence.`} onClick={() => showChange(items[items.length - 1]!)} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); showChange(items[items.length - 1]!);}}}>
                  <circle className="eh-point-hit" cx={at} cy={plot.markerY} r={13}/><path d={`M ${at} ${plot.markerY - 6} l 6 6 -6 6 -6 -6 Z`} className="eh-marker-dot"/><title>{day}: {items.map(item => item.label).join('; ')}</title>
                </g>;
              })}
              {tickIndexes.map(index => points[index] && <text key={index} className="eh-axis" x={x(index)} y="291" textAnchor="middle" aria-hidden="true">{dayLabel.format(new Date(`${points[index]!.day}T12:00:00Z`))}</text>)}
            </svg>
          </div>
          <div className="eh-caption"><span><i className="eh-dot-key"/> {source === 'tokens' ? 'Complete-turn counter deltas' : source === 'direct' ? 'Declared work cycles' : 'Observed job evidence'} · {metricInfo.unit}</span><span>Gaps = no sample · days in {history.timeZone}</span></div>
          <div className="eh-changes-heading"><GitBranch size={16}/><h4>{source === 'tokens' ? 'Other recorded changes (not token-attributed)' : source === 'direct' ? 'Other recorded changes (not cycle-attributed)' : 'Changes and context inclusion'}</h4><span>{changes.length} in this period</span></div>
          {latestChanges.length ? <div className="eh-change-list">{latestChanges.map(changeButton)}</div> : <p className="eh-empty-copy">No recorded changes in this period.</p>}
          {selectedChange && <div className="eh-detail" aria-live="polite">
            <span className="eh-summary-label">Recorded change · {timestamp(selectedChange.at)}</span><h4>{selectedChange.label}</h4><p>{describeScope(selectedChange).label} · {selectedChange.kind === 'knowledge-use' ? 'context inclusion' : selectedChange.kind.replaceAll('-', ' ')}</p>
            {(changesByDay.get(selectedChange.day)?.length ?? 0) > 1 && <div className="eh-same-day">{changesByDay.get(selectedChange.day)!.map(change => <button key={change.id} type="button" aria-pressed={change.id === selectedChange.id} onClick={() => showChange(change)}>{change.label}</button>)}</div>}
            {(selectedChange.before !== null || selectedChange.after !== null) && <dl className="eh-change-values"><div><dt>Before</dt><dd>{selectedChange.before ?? 'Not recorded'}</dd></div><div><dt>After</dt><dd>{selectedChange.after ?? 'Not recorded'}</dd></div></dl>}
            {selectedChange.jobId && <button type="button" className="subtle-link" onClick={() => onOpenRun(selectedChange.jobId!)}>Inspect run <ArrowUpRight size={13}/></button>}
            <details><summary>Evidence ({selectedChange.evidence.length})</summary><div className="eh-references">{selectedChange.evidence.map((ref, index) => <CopyId key={`${index}-${ref}`} value={ref} {...copy}/>)}</div></details>
            <details><summary>Technical scope</summary><div className="eh-references"><CopyId value={selectedChange.scope} {...copy}/></div></details>
          </div>}
          {selectedPoint && <div className="eh-detail" aria-live="polite"><span className="eh-summary-label">Observed point · {selectedPoint.day}</span><h4>{selectedPoint.value === null ? 'No sample' : `${numbers.format(selectedPoint.value)} ${metricInfo.unit}`}</h4><p>Sample: {selectedPoint.n} {sampleUnit}.</p>
            {selectedPoint.jobIds.length > 0 && <details><summary>Recorded jobs ({selectedPoint.jobIds.length})</summary><div className="eh-references">{selectedPoint.jobIds.map(id => <div className="eh-run-ref" key={id}><CopyId value={id} {...copy}/><button type="button" className="subtle-link" onClick={() => onOpenRun(id)}>Inspect run <ArrowUpRight size={13}/></button></div>)}</div></details>}
            {source === 'tokens' && <details><summary>Interaction and turn identities</summary><div className="eh-references">{[...(selectedPoint.interactionIds ?? []), ...(selectedPoint.turnIds ?? [])].map(id => <CopyId key={id} value={id} {...copy}/>)}</div></details>}
            <details><summary>{selectedMetric === 'duration' ? 'Evaluation receipts' : 'Evidence'} ({selectedPoint.evidence.length})</summary><div className="eh-references">{selectedPoint.evidence.map((ref, index) => <CopyId key={`${index}-${ref}`} value={ref} {...copy}/>)}</div></details>
          </div>}
          <div className="eh-details-grid">
            <details><summary>Daily values and samples</summary><div className="eh-table-scroll"><table><caption>{metricInfo.label} · {metricInfo.unit}</caption><thead><tr><th scope="col">Day</th><th scope="col">Value</th><th scope="col">Sample</th><th scope="col">Evidence</th></tr></thead><tbody>{points.map(point => <tr key={point.day}><th scope="row">{point.day}</th><td>{point.value === null ? 'No sample' : numbers.format(point.value)}</td><td>{point.value === null ? '—' : numbers.format(point.n)}</td><td>{point.value !== null && <button type="button" onClick={() => setDetailSelection({kind: 'point', id: point.day})}>Inspect</button>}</td></tr>)}</tbody></table></div></details>
            <details><summary>All changes ({changes.length})</summary><div className="eh-change-list eh-all-changes">{[...changes].sort((a, b) => b.at.localeCompare(a.at)).map(changeButton)}</div></details>
            <details><summary>Method and coverage</summary><div className="eh-method"><p>{source === 'tokens' ? `${tokenAggregation === 'mean' ? 'Each point divides observed token deltas by the complete turns with that counter.' : 'Each point totals observed token deltas; workload volume affects the total.'} Project and declared work scope remain separate. N is specific to the selected counter; missing or partial turns and cumulative worker receipts are excluded.` : source === 'direct' ? 'Completed cycles are declared interaction transitions. Elapsed time is wall-clock time, not active labor or model cost.' : selectedMetric === 'duration' ? 'Each point is the mean of measured check durations within the selected compatible cohort.' : 'Daily outcomes and attempts describe this workload. A different task mix can change these values.'}</p>
              {source === 'tokens' && history.telemetry && <><p>Telemetry: {history.telemetry.enabled ? 'enabled' : 'off'} · {history.telemetry.completeTurns} complete turns · {history.telemetry.incompleteTurns} incomplete · {history.telemetry.unassignedTurns} without a comparable assignment.</p>{history.telemetry.truncated && <p>The telemetry read limit was reached; coverage is partial.</p>}{history.telemetry.warnings.length > 0 && <ul>{history.telemetry.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</>}
              {series && selectedMetric === 'duration' && <dl className="eh-change-values"><div><dt>Method</dt><dd>{series.method}</dd></div><div><dt>Cohort</dt><dd>{series.cohort}</dd></div></dl>}
              <p>Changes and later outcomes establish chronology. Their causal effect requires the linked improvement and comparable use evidence.</p>
              {history.coverage.truncated && <p>Some source inventories reached their read limit; this view is partial.</p>}
              {history.coverage.warnings.length > 0 && <ul>{history.coverage.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
              {history.limitations.length > 0 && <ul>{history.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}
            </div></details>
          </div>
        </>}
      </div>
    </InfoCard>
  </section>;
}
