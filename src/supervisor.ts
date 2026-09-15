import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DrainResult } from './queue.js';
import { atomicWriteJson, errorMessage, makeId, readJson, resolveRealSubPath } from './legacy/command-os-utils.js';

export interface SupervisorOptions { maxJobs: number; totalTimeoutMs: number; concurrency?:number; jobIds?:string[]; workflowId?:string; mode?:'queue'|'learning';continueIndependent?:boolean }
export interface SupervisorReceipt { id: string; pid: number; path: string; createdAt: string }
export interface SupervisorRequest extends SupervisorOptions {
  version: 1;
  id: string;
  root: string;
  path: string;
  createdAt: string;
}
export type SupervisorState = 'starting' | 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface SupervisorRecord {
  id: string;
  state: SupervisorState;
  pid: number | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  result: DrainResult | null;
  error: string | null;
}
export interface SupervisorStatus extends SupervisorRecord {
  path: string;
  cancelRequested: boolean;
  /** PID existence is advisory; it is not proof of ownership and never authorizes a later kill. */
  pidExists: boolean | null;
}

/** Starts a bounded detached queue process; never installs a service, retries a job or schedules a restart. */
export class SupervisorManager {
  static readonly maxDurationMs = 7_200_000;
  constructor(private readonly root: string) {}

  async start(options: SupervisorOptions): Promise<SupervisorReceipt> {
    this.validateOptions(options);
    const root = await fs.realpath(this.root);
    const workerPath = await fs.realpath(fileURLToPath(new URL('./queue-worker.js', import.meta.url)));
    let parent = root;
    for (const segment of ['artifacts', 'supervisors']) {
      parent = path.join(parent, segment);
      try { await fs.mkdir(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !await resolveRealSubPath(parent, root)) throw new Error('Supervisor artifacts must stay inside the infrastructure');
    }
    const id = makeId('supervisor');
    const directory = path.join(parent, id);
    await fs.mkdir(directory);
    const createdAt = new Date().toISOString();
    const request: SupervisorRequest = { version: 1, id, root, path: directory, createdAt,
      maxJobs: options.maxJobs, totalTimeoutMs: options.totalTimeoutMs, ...(options.mode?{mode:options.mode}:{}),...(options.continueIndependent!==undefined?{continueIndependent:options.continueIndependent}:{}),
      ...(options.concurrency?{concurrency:options.concurrency}:{}),...(options.jobIds?{jobIds:options.jobIds}:{}),...(options.workflowId?{workflowId:options.workflowId}:{}) };
    const starting: SupervisorRecord = { id, state: 'starting', pid: null, createdAt, startedAt: null,
      updatedAt: createdAt, finishedAt: null, result: null, error: null };
    await atomicWriteJson(path.join(directory, 'request.json'), request);
    await atomicWriteJson(path.join(directory, 'status.json'), starting);
    const stdout = await fs.open(path.join(directory, 'stdout.log'), 'wx');
    const stderr = await fs.open(path.join(directory, 'stderr.log'), 'wx');
    try {
      const child = spawn(process.execPath, [workerPath, '--root', root, '--id', id], {
        cwd: root, detached: true, windowsHide: true, shell: false,
        stdio: ['ignore', stdout.fd, stderr.fd],
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      if (!child.pid) throw new Error('Supervisor started without a process ID');
      child.unref();
      const receipt: SupervisorReceipt = { id, pid: child.pid, path: directory, createdAt };
      await atomicWriteJson(path.join(directory, 'receipt.json'), receipt);
      return receipt;
    } catch (error) {
      // A launch failure is inspectable; no historical PID is targeted for cleanup.
      await atomicWriteJson(path.join(directory, 'cancel.json'), { requestedAt: new Date().toISOString(), reason: 'launch_failed' });
      await atomicWriteJson(path.join(directory, 'status.json'), { ...starting, state: 'failed',
        updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: errorMessage(error) });
      throw new Error(`Supervisor launch failed; inspect ${directory}: ${errorMessage(error)}`);
    } finally { await stdout.close(); await stderr.close(); }
  }

  async status(id: string): Promise<SupervisorStatus> {
    const request = await this.loadRequest(id);
    const record = await readJson(path.join(request.path, 'status.json'), null) as SupervisorRecord | null;
    if (!record || record.id !== id) throw new Error('Supervisor status is unavailable');
    const receipt = await readJson(path.join(request.path, 'receipt.json'), null) as SupervisorReceipt | null;
    const pid = record.pid ?? receipt?.pid ?? null;
    let pidExists: boolean | null = null;
    if (pid !== null) {
      try { process.kill(pid, 0); pidExists = true; }
      catch (error) { pidExists = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    }
    const cancelRequested = await readJson(path.join(request.path, 'cancel.json'), null) !== null;
    if (pidExists === false && (record.state === 'starting' || record.state === 'running')) {
      return { ...record, pid, state: 'interrupted', path: request.path, pidExists, cancelRequested,
        error: 'Supervisor PID is absent. Inspect persisted jobs and reconcile explicitly; no actions were replayed.' };
    }
    return { ...record, pid, path: request.path, pidExists, cancelRequested };
  }

  async cancel(id: string): Promise<SupervisorStatus> {
    const status = await this.status(id);
    if (['completed', 'stopped', 'failed'].includes(status.state) || status.cancelRequested) return status;
    await atomicWriteJson(path.join(status.path, 'cancel.json'), { requestedAt: new Date().toISOString() });
    return { ...status, cancelRequested: true };
  }

  /** Used by the fixed queue-worker entrypoint; the request contains no executable or new objective. */
  async loadRequest(id: string): Promise<SupervisorRequest> {
    if (!/^supervisor_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid supervisor ID');
    const root = await fs.realpath(this.root);
    const directory = path.join(root, 'artifacts', 'supervisors', id);
    const actual = await resolveRealSubPath(directory, root);
    if (!actual || path.relative(actual, directory) !== '' || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('Supervisor record is missing or outside the infrastructure');
    const request = await readJson(path.join(directory, 'request.json'), null) as SupervisorRequest | null;
    if (!request || request.version !== 1 || request.id !== id || path.relative(request.root, root) !== '' || path.relative(request.path, directory) !== '') throw new Error('Supervisor request does not match its owner directory');
    this.validateOptions(request);
    return request;
  }

  private validateOptions(options: SupervisorOptions): void {
    if(options.mode!==undefined && !['queue','learning'].includes(options.mode))throw new Error('Invalid supervisor mode');
    if(options.mode==='learning' && (options.jobIds||options.workflowId||options.concurrency||options.continueIndependent))throw new Error('Learning supervisor owns its bounded case scope');
    if(options.continueIndependent && !options.jobIds?.length)throw new Error('Independent continuation requires an explicit job scope');
    if (!Number.isSafeInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > 100) throw new Error('Supervisor maxJobs must be between 1 and 100');
    if (!Number.isSafeInteger(options.totalTimeoutMs) || options.totalTimeoutMs < 1000 || options.totalTimeoutMs > SupervisorManager.maxDurationMs) throw new Error('Supervisor duration must be between 1000 and 7200000 ms');
    if(options.concurrency!==undefined && (!Number.isSafeInteger(options.concurrency)||options.concurrency<1||options.concurrency>4))throw new Error('Supervisor concurrency must be between 1 and 4');
    if(options.jobIds && (!Array.isArray(options.jobIds)||!options.jobIds.length||options.jobIds.length>100||new Set(options.jobIds).size!==options.jobIds.length||options.jobIds.some(id=>typeof id!=='string'||!id.trim())))throw new Error('Invalid supervisor job scope');
    if(options.workflowId && !/^workflow_[a-f0-9-]{36}$/.test(options.workflowId))throw new Error('Invalid workflow ID');
  }
}
