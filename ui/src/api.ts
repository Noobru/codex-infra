import { useCallback, useEffect, useRef, useState } from 'react';
import type { ObservationOverview, ObservationSummary, RunObservation } from '../../src/observability';
import type {DashboardObservation,DashboardOptions} from '../../src/dashboard';

export type { ObservationOverview, ObservationSummary, RunObservation };
export type {DashboardObservation,DashboardOptions};

/** A single client for the canonical, aggregated read-only observation API. */
class ObservationClient {
  private readonly snapshots = new Map<string,{etag:string;data:unknown}>();
  private async read<T>(url: string, signal: AbortSignal): Promise<T> {
    const cached=this.snapshots.get(url);
    const response = await fetch(url, { signal, cache: 'no-store', headers: { Accept: 'application/json',...(cached?{'If-None-Match':cached.etag}:{}) } });
    if(response.status===304&&cached)return {...cached.data as object,observedAt:response.headers.get('X-Observed-At')} as T;
    if (!response.ok) {
      const failure=await response.json().catch(()=>null) as {error?:string}|null;
      const message = response.status === 404 ? 'This run is no longer available.'
        : response.status === 503 ? failure?.error==='database_busy'?'The local queue is busy. Wait briefly or use Refresh to retry.':'The observation source is temporarily unavailable.'
        : `Observation request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }
    const data=await response.json() as T;
    const etag=response.headers.get('etag');
    if(etag){this.snapshots.set(url,{etag,data});if(this.snapshots.size>32)this.snapshots.delete(this.snapshots.keys().next().value!);}
    return data;
  }

  screen(options:DashboardOptions,signal:AbortSignal){
    const query=new URLSearchParams({view:options.view??'overview',limit:'20',offset:String(options.offset??0),sort:options.sort??'newest'});
    const fields={project_id:options.projectId,job_id:options.jobId,status:options.status,query:options.query,
      after_event_id:options.afterEventId,evaluation_offset:options.evaluationOffset,
      history_days:options.historyDays,population:options.population,
      interaction_offset:options.interactionOffset,interaction_limit:options.interactionLimit,interaction_status:options.interactionStatus,
      baseline_id:options.comparison?.baselineId,treatment_id:options.comparison?.treatmentId,metric_id:options.comparison?.metricId};
    for(const [key,value] of Object.entries(fields))if(value!==undefined&&value!=='')query.set(key,String(value));
    return this.read<DashboardObservation>(`/api/view?${query}`,signal);
  }

  overview(projectId: string, offset: number, signal: AbortSignal) {
    const query = new URLSearchParams({ limit: '20', offset: String(offset) });
    if (projectId) query.set('project_id', projectId);
    return this.read<ObservationOverview>(`/api/overview?${query}`, signal);
  }

  run(id: string, afterEventId: number, signal: AbortSignal) {
    const query = new URLSearchParams({ after_event_id: String(afterEventId), limit: '50' });
    return this.read<RunObservation>(`/api/runs/${encodeURIComponent(id)}?${query}`, signal);
  }
}

export const observationClient = new ObservationClient();

/** Keeps the last observed snapshot on a refresh failure; a new scope starts empty. */
export function useObservation<T>(loader: ((signal: AbortSignal) => Promise<T>) | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let alive = true;
    let pending = false;
    let request: AbortController | null = null;
    setData(null);
    setError(null);
    setLoading(false);
    if (!loader) { refreshRef.current = () => {}; return; }

    const read = async () => {
      if (pending || !alive) return;
      pending = true;
      request = new AbortController();
      let timedOut=false;
      const timer=window.setTimeout(()=>{timedOut=true;request?.abort();},15000);
      setLoading(true);
      try {
        const result = await loader(request.signal);
        if (alive) { setData(result); setError(null); }
      } catch (failure) {
        if(alive&&timedOut)setError('The local source took too long to respond. Use Refresh to retry.');
        else if (alive && !request.signal.aborted) setError(failure instanceof Error ? failure.message : 'The local observation source could not be read.');
      } finally {
        pending = false;
        window.clearTimeout(timer);
        if (alive) setLoading(false);
      }
    };
    refreshRef.current = () => { void read(); };
    void read();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 5000);
    return () => {
      alive = false;
      request?.abort();
      window.clearInterval(interval);
      refreshRef.current = () => {};
    };
  }, [loader]);

  return { data, error, loading, refresh };
}
