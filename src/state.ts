import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JobStatus = 'ready' | 'running' | 'validating' | 'waiting_user' | 'waiting_quota' | 'failed' | 'cancelled' | 'completed';
export type JobMode = 'read-only' | 'workspace-write';

export interface Job {
  id: string;
  projectId: string;
  objective: string;
  mode: JobMode;
  profileHash: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  threadId: string | null;
  turnId: string | null;
  result: string | null;
  error: string | null;
  ownerPid: number | null;
}

export interface CreateJobInput {
  idempotencyKey: string;
  projectId: string;
  objective: string;
  mode: JobMode;
  profileHash: string;
  dependencyIds?: string[];
  resourceKey?: string;
  isolatedWorkspace?: boolean;
  executionKind?: 'checks' | 'codex';
  initialStatus?: 'ready'|'waiting_user';
}

export type JobPatch = Partial<Pick<Job, 'threadId' | 'turnId' | 'result' | 'error' | 'ownerPid'>>;

export interface JobEvent {
  id: number;
  jobId: string;
  createdAt: string;
  fromStatus: JobStatus | null;
  toStatus: JobStatus;
  detail: { action: string; fields?: string[]; reason?: string };
}

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  ready: ['waiting_user', 'waiting_quota', 'failed', 'cancelled'],
  running: ['validating', 'waiting_user', 'waiting_quota', 'failed', 'cancelled'],
  validating: ['completed', 'waiting_user', 'waiting_quota', 'failed', 'cancelled'],
  waiting_user: ['ready', 'cancelled'],
  waiting_quota: ['ready', 'cancelled'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
  completed: [],
};

/** One canonical durable queue, shared by CLI, MCP and worker processes. */
export class StateStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string, options: {readOnly?:boolean} = {}) {
    if (!options.readOnly && dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath,{readOnly:options.readOnly??false});
    try {
      if(options.readOnly) {
        this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA query_only = ON;');
        const version=this.db.prepare('PRAGMA user_version').get()?.user_version;
        if(version!==2 && version!==3) throw new Error(`Unsupported read-only state schema version: ${String(version)}`);
        return;
      }
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
        if (![0,1,2,3].includes(Number(version))) throw new Error(`Unsupported state schema version: ${String(version)}`);
        if (version === 0) {
          this.db.exec(`
            CREATE TABLE jobs (
              id TEXT PRIMARY KEY,
              idempotency_key TEXT NOT NULL UNIQUE,
              projectId TEXT NOT NULL,
              objective TEXT NOT NULL,
              mode TEXT NOT NULL CHECK (mode IN ('read-only', 'workspace-write')),
              profileHash TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'validating', 'waiting_user', 'waiting_quota', 'failed', 'cancelled', 'completed')),
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
              threadId TEXT,
              turnId TEXT,
              result TEXT,
              error TEXT,
              ownerPid INTEGER,
              CHECK ((status IN ('running', 'validating') AND ownerPid IS NOT NULL AND ownerPid > 0) OR
                     (status NOT IN ('running', 'validating') AND ownerPid IS NULL))
            );
            CREATE UNIQUE INDEX one_active_job_per_project ON jobs(projectId)
              WHERE status IN ('running', 'validating');
            CREATE TABLE job_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              jobId TEXT NOT NULL REFERENCES jobs(id),
              createdAt TEXT NOT NULL,
              fromStatus TEXT,
              toStatus TEXT NOT NULL,
              detail TEXT NOT NULL
            );
            CREATE INDEX events_by_job ON job_events(jobId, id);
            PRAGMA user_version = 1;
          `);
        }
        if (version === 0 || version === 1) {
          this.db.exec(`
            CREATE TABLE job_dependencies (
              jobId TEXT NOT NULL REFERENCES jobs(id),
              dependencyId TEXT NOT NULL REFERENCES jobs(id),
              PRIMARY KEY (jobId, dependencyId),
              CHECK (jobId <> dependencyId)
            );
            PRAGMA user_version = 2;
          `);
        }
        if (Number(version) < 3) {
          this.db.exec(`ALTER TABLE jobs ADD COLUMN resourceKey TEXT NOT NULL DEFAULT '';
            ALTER TABLE jobs ADD COLUMN executionKind TEXT NOT NULL DEFAULT 'codex' CHECK (executionKind IN ('checks','codex'));
            UPDATE jobs SET resourceKey = 'legacy:' || projectId;
            DROP INDEX one_active_job_per_project;
            CREATE UNIQUE INDEX one_active_job_per_resource ON jobs(resourceKey) WHERE status IN ('running','validating');
            PRAGMA user_version = 3;`);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  create(input: CreateJobInput): Job {
    for (const key of ['idempotencyKey', 'projectId', 'objective', 'profileHash'] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} must be nonempty`);
    }
    if (input.mode !== 'read-only' && input.mode !== 'workspace-write') throw new Error('Invalid job mode');
    const dependencyIds = input.dependencyIds ?? [];
    if (!Array.isArray(dependencyIds) || dependencyIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(dependencyIds).size !== dependencyIds.length) {
      throw new Error('dependencyIds must contain distinct existing job IDs');
    }
    const sortedDependencies = [...dependencyIds].sort();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id, resourceKey, executionKind FROM jobs WHERE idempotency_key = ?').get(input.idempotencyKey);
      if (existing) {
        const job = this.get(String(existing.id));
        if (sortedDependencies.includes(job.id)) throw new Error('A job cannot depend on itself');
        if (job.projectId !== input.projectId || job.objective !== input.objective || job.mode !== input.mode || job.profileHash !== input.profileHash ||
          JSON.stringify(this.dependencies(job.id)) !== JSON.stringify(sortedDependencies)) {
          throw new Error('Idempotency key already belongs to a different job request');
        }
        if (input.resourceKey !== undefined && existing.resourceKey !== (input.isolatedWorkspace ? 'worktree:'+job.id : input.resourceKey)) throw new Error('Idempotency key has a different workspace resource');
        if (input.executionKind !== undefined && existing.executionKind !== input.executionKind) throw new Error('Idempotency key has a different execution kind');
        return job;
      }
      const id = randomUUID();
      // Only immutable references to older jobs are accepted, so creation cannot introduce a cycle.
      for (const dependencyId of sortedDependencies) this.get(dependencyId);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO jobs
        (id, idempotency_key, projectId, objective, mode, profileHash, status, createdAt, updatedAt, resourceKey, executionKind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.idempotencyKey, input.projectId, input.objective, input.mode, input.profileHash,input.initialStatus??'ready', now, now,
          input.isolatedWorkspace ? 'worktree:'+id : input.resourceKey ?? 'legacy:'+input.projectId, input.executionKind ?? 'codex');
      const insertDependency = this.db.prepare('INSERT INTO job_dependencies (jobId, dependencyId) VALUES (?, ?)');
      for (const dependencyId of sortedDependencies) insertDependency.run(id, dependencyId);
      this.event(id, null, input.initialStatus??'ready', { action: input.initialStatus==='waiting_user'?'workflow-prepare':'create' }, now);
      return this.get(id);
    });
  }

  get(id: string): Job {
    const row = this.db.prepare(`SELECT id, projectId, objective, mode, profileHash, status,
      createdAt, updatedAt, attempts, threadId, turnId, result, error, ownerPid FROM jobs WHERE id = ?`).get(id);
    if (!row) throw new Error(`Job not found: ${id}`);
    return { ...row } as unknown as Job;
  }

  list(): Job[] {
    return this.db.prepare(`SELECT id, projectId, objective, mode, profileHash, status,
      createdAt, updatedAt, attempts, threadId, turnId, result, error, ownerPid
      FROM jobs ORDER BY createdAt, rowid`).all().map((row) => ({ ...row }) as unknown as Job);
  }

  dependencies(id: string): string[] {
    this.get(id);
    return this.db.prepare('SELECT dependencyId FROM job_dependencies WHERE jobId = ? ORDER BY dependencyId').all(id).map((row) => String(row.dependencyId));
  }

  /** Selection is advisory; claim rechecks dependencies and concurrency inside its transaction. */
  resource(id:string): {resourceKey:string; executionKind:'checks'|'codex'} {
    this.get(id);
    return {...this.db.prepare('SELECT resourceKey, executionKind FROM jobs WHERE id = ?').get(id)} as {resourceKey:string;executionKind:'checks'|'codex'};
  }

  static resourcesConflict(a:string,b:string):boolean {
    return a===b || (a.startsWith('root:') && b.startsWith('root:') && (a.startsWith(b+'/') || b.startsWith(a+'/')));
  }

  nextReady(options:{jobIds?:string[];excludeIds?:string[];maxModelWorkers?:number} = {}): Job | null {
    const rows = this.db.prepare(`SELECT job.id, job.resourceKey, job.executionKind FROM jobs AS job WHERE job.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM job_dependencies AS dependency JOIN jobs AS parent ON parent.id = dependency.dependencyId
        WHERE dependency.jobId = job.id AND parent.status <> 'completed'
      ) ORDER BY job.createdAt, job.rowid`).all();
    const reservations = new Set(options.excludeIds ?? []);
    for(const job of this.list()) if(['running','validating'].includes(job.status)) reservations.add(job.id);
    const occupied = [...reservations].map(id=>this.resource(id));
    const row = rows.find(row => (!options.jobIds || options.jobIds.includes(String(row.id))) && !reservations.has(String(row.id)) &&
      !occupied.some(resource=>StateStore.resourcesConflict(resource.resourceKey,String(row.resourceKey))) &&
      !(row.executionKind==='codex' && options.maxModelWorkers!==undefined && occupied.filter(r=>r.executionKind==='codex').length>=options.maxModelWorkers));
    return row ? this.get(String(row.id)) : null;
  }

  claim(id: string, ownerPid: number, maxActive?: number, maxModelWorkers?:number): Job {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('ownerPid must be a positive integer');
    if (maxActive !== undefined && (!Number.isSafeInteger(maxActive) || maxActive < 1)) throw new Error('Invalid concurrency limit');
    return this.transaction(() => {
      const job = this.get(id);
      if (job.status !== 'ready') throw new Error(`Cannot claim job in ${job.status}`);
      const unfinishedDependency = this.db.prepare(`SELECT dependency.dependencyId FROM job_dependencies AS dependency
        JOIN jobs AS parent ON parent.id = dependency.dependencyId
        WHERE dependency.jobId = ? AND parent.status <> 'completed' LIMIT 1`).get(id);
      if (unfinishedDependency) throw new Error(`Job dependency is not completed: ${String(unfinishedDependency.dependencyId)}`);
      const resource = this.resource(id);
      const activeJobs = this.db.prepare("SELECT id, resourceKey, executionKind FROM jobs WHERE status IN ('running', 'validating')").all();
      const active = activeJobs.find(other=>StateStore.resourcesConflict(resource.resourceKey,String(other.resourceKey)));
      if (active) throw new Error(`Project resource already has an active job: ${String(active.id)}`);
      const activeCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('running', 'validating')").get()?.count);
      if (maxActive !== undefined && activeCount >= maxActive) throw new Error('Global concurrency limit reached');
      if (resource.executionKind==='codex' && maxModelWorkers!==undefined && activeJobs.filter(j=>j.executionKind==='codex').length>=maxModelWorkers) throw new Error('Model concurrency limit reached');
      const now = new Date().toISOString();
      const updated = this.db.prepare(`UPDATE jobs SET status = 'running', ownerPid = ?,
        attempts = attempts + 1, updatedAt = ? WHERE id = ? AND status = 'ready'`).run(ownerPid, now, id);
      if (updated.changes !== 1) throw new Error('Job claim lost a concurrent update');
      this.event(id, 'ready', 'running', { action: 'claim' }, now);
      return this.get(id);
    });
  }

  transition(id: string, status: JobStatus, patch: JobPatch = {}): Job {
    return this.transaction(() => {
      const job = this.get(id);
      const sameStatus = job.status === status && status !== 'completed' && status !== 'cancelled';
      if (!sameStatus && !transitions[job.status].includes(status)) {
        throw new Error(`Illegal job transition: ${job.status} -> ${status}`);
      }
      const next = { ...job };
      if (status === 'ready' && job.status !== 'ready') {
        next.turnId = null;
        next.result = null;
        next.error = null;
      }
      const fields = ['threadId', 'turnId', 'result', 'error', 'ownerPid'] as const;
      for (const field of fields) {
        const value = patch[field];
        if (value === undefined) continue;
        if (field === 'ownerPid') {
          if (value !== null && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new Error('Invalid ownerPid');
          next.ownerPid = value as number | null;
        } else {
          if (value !== null && typeof value !== 'string') throw new Error(`Invalid ${field}`);
          next[field] = value as string | null;
        }
      }
      if (status !== 'running' && status !== 'validating') next.ownerPid = null;
      else if (next.ownerPid === null) throw new Error('Active job requires an owner');
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE jobs SET status = ?, updatedAt = ?, threadId = ?, turnId = ?,
        result = ?, error = ?, ownerPid = ? WHERE id = ? AND status = ?`)
        .run(status, now, next.threadId, next.turnId, next.result, next.error, next.ownerPid, id, job.status);
      this.event(id, job.status, status, { action: 'transition', fields: fields.filter((field) => patch[field] !== undefined) }, now);
      return this.get(id);
    });
  }

  /** Atomic queue reconciliation: never races a claim into cancelling a live owner. */
  cancelPending(id: string): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (job.ownerPid !== null || !['ready','waiting_user','waiting_quota'].includes(job.status)) return job;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE jobs SET status = 'cancelled', updatedAt = ? WHERE id = ? AND status = ? AND ownerPid IS NULL").run(now,id,job.status);
      this.event(id,job.status,'cancelled',{action:'superseded-learning-reconciliation'},now);
      return this.get(id);
    });
  }

  events(id: string): JobEvent[] {
    this.get(id);
    return this.db.prepare('SELECT * FROM job_events WHERE jobId = ? ORDER BY id').all(id).map((row) => ({
      id: Number(row.id),
      jobId: String(row.jobId),
      createdAt: String(row.createdAt),
      fromStatus: row.fromStatus as JobStatus | null,
      toStatus: row.toStatus as JobStatus,
      detail: JSON.parse(String(row.detail)) as JobEvent['detail'],
    }));
  }

  /** Lost workers require an explicit decision; restarting never replays their actions. */
  reconcile(isAlive: (pid: number) => boolean): Job[] {
    return this.transaction(() => {
      const activeIds = this.db.prepare("SELECT id FROM jobs WHERE status IN ('running', 'validating') ORDER BY createdAt, rowid").all();
      const recovered: Job[] = [];
      for (const row of activeIds) {
        const job = this.get(String(row.id));
        // Missing ownership alone does not prove that an incompletely stopped child process is gone.
        // Only explicit cleanup confirmation may release this project's active slot, including after restore.
        if (job.error?.startsWith('Unconfirmed cleanup:')) continue;
        if (job.ownerPid !== null && isAlive(job.ownerPid)) continue;
        const now = new Date().toISOString();
        this.db.prepare(`UPDATE jobs SET status = 'waiting_user', ownerPid = NULL, updatedAt = ?,
          error = ? WHERE id = ? AND status = ?`).run(now, 'Worker owner is absent; review evidence before an explicit retry.', job.id, job.status);
        this.event(job.id, job.status, 'waiting_user', { action: 'reconcile', reason: 'owner_absent' }, now);
        recovered.push(this.get(job.id));
      }
      return recovered;
    });
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private event(jobId: string, fromStatus: JobStatus | null, toStatus: JobStatus, detail: JobEvent['detail'], now: string): void {
    this.db.prepare('INSERT INTO job_events (jobId, createdAt, fromStatus, toStatus, detail) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, now, fromStatus, toStatus, JSON.stringify(detail));
  }
}
