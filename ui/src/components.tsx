import type {ReactNode} from 'react';
import type { LucideIcon } from 'lucide-react';
import { Activity, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronRight, Clipboard, Clock3, Copy, Database, FileCheck2, Info, Layers3, LayoutDashboard, LockKeyhole, Play, RefreshCw, Search, ShieldCheck, Sparkles, TerminalSquare, TriangleAlert, Workflow, XCircle, Zap } from 'lucide-react';
import type {ObservationSummary} from './api';

export type Tone = 'cyan' | 'amber' | 'coral' | 'green' | 'neutral';
export type View = 'overview' | 'live' | 'efficiency' | 'project' | 'evidence' | 'learning';
export type Status = ObservationSummary['status'];
export type CopyProps = { copiedId: string | null; onCopy: (value: string) => void };
export const states: Record<Status, { label: string; tone: Tone; icon: LucideIcon }> = {
  ready: { label: 'ready', tone: 'neutral', icon: Clock3 }, running: { label: 'running', tone: 'cyan', icon: Play },
  validating: { label: 'validating', tone: 'cyan', icon: FileCheck2 }, waiting_user: { label: 'waiting user', tone: 'amber', icon: Clock3 },
  waiting_quota: { label: 'waiting quota', tone: 'amber', icon: Clock3 }, failed: { label: 'failed', tone: 'coral', icon: XCircle },
  cancelled: { label: 'cancelled', tone: 'neutral', icon: XCircle }, completed: { label: 'completed', tone: 'green', icon: CheckCircle2 },
};
export const views: { id: View; title: string; icon: LucideIcon; stage?: string; description: string }[] = [
  { id: 'overview', title: 'Overview', icon: LayoutDashboard, description: 'Recorded work, current states, and the evidence available to inspect.' },
  { id: 'live', title: 'Live Run', icon: Activity, description: 'Inspect one recorded run, its contract, routing, checks, and timeline.' },
  { id: 'efficiency', title: 'Efficiency', icon: Zap, description: 'Observed quantities and the evidence still needed to measure a gain.' },
  { id: 'project', title: 'Project View', icon: Layers3, description: 'Registered projects and their recorded activity, ready to inspect.' },
  { id: 'evidence', title: 'Evidence & Recovery', icon: ShieldCheck, description: 'Recorded evidence, backup manifests and dated recovery checks.' },
  { id: 'learning', title: 'Learning Queue', icon: Sparkles, description: 'Review declared candidates and the signals that support a learning decision.' },
];
export const activeStates = new Set<Status>(['ready', 'running', 'validating', 'waiting_user', 'waiting_quota']);
export const numbers = new Intl.NumberFormat('en-US');
export function measured(value: number | null | undefined): string { return value == null ? 'unknown' : numbers.format(value); }
export function timestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'unknown';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function duration(value: number | null | undefined): string {
  if (value == null) return 'unknown';
  if(value < 1000) return `${value} ms`;
  const seconds = Math.floor(value / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
export function StatusBadge({ status, compact = false }: { status: Status; compact?: boolean }) {
  const { label, tone, icon: Icon } = states[status] ?? { label: 'unknown', tone: 'neutral', icon: Info };
  return <span className={`status-badge status-${tone} ${compact ? 'status-compact' : ''}`}><Icon size={12} />{label}</span>;
}
export function MetricCard({ label, value, note, tone, icon: Icon, onClick }: { label: string; value: string; note: string; tone: Tone; icon: LucideIcon; onClick?:()=>void }) {
  const Tag=onClick?'button':'article';
  return <Tag onClick={onClick} {...(onClick?{type:'button' as const,'aria-label':`Inspect ${label} tasks`}:{})} className={`metric-card metric-${tone} ${onClick?'metric-interactive':''}`}><div className="metric-card-top"><span className="metric-icon"><Icon size={15} /></span><span className="metric-note">{note}</span></div><div className={`metric-value ${value === 'unknown' ? 'unknown-value' : ''}`}>{value}</div><div className="metric-label">{label}{onClick&&<ChevronRight size={15}/>}</div></Tag>;
}
export function CopyId({ value, copiedId, onCopy }: { value: string } & CopyProps) {
  return <button className="copy-id" type="button" title={value} aria-label={`Copy ${value}`} onClick={() => onCopy(value)}><span>{value}</span>{copiedId === value ? <Check size={12} /> : <Copy size={12} />}</button>;
}
export function InfoCard({ icon: Icon, title, meta, children, className = '' }: { icon: LucideIcon; title: string; meta: string; children: ReactNode; className?: string }) {
  return <section className={`panel info-card ${className}`}><div className="panel-heading"><div className="panel-title"><span className="panel-icon"><Icon size={15} /></span><h3>{title}</h3></div><span className="panel-meta">{meta}</span></div>{children}</section>;
}
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-icon"><Search size={17} /></div><strong>{title}</strong><span>{detail}</span></div>;
}
export function ScopeNote({ children }: { children: ReactNode }) {
  return <div className="efficiency-footnote"><Info size={14} /><span>{children}</span></div>;
}
export function SectionHeading({ title, label, count }: { title: string; label: string; count?: string }) {
  return <div className="section-heading"><div><div className="section-kicker"><span className="eyebrow-dot cyan-dot" />{label}</div><h2>{title}</h2></div>{count && <span className="section-count">{count}</span>}</div>;
}

