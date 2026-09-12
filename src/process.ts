import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

export interface CommandOptions { signal?: AbortSignal; outputFiles?: {stdout:string;stderr:string}; pathPrepend?: string[]; /** Complete environment override; omitted preserves the existing host environment. */ env?: NodeJS.ProcessEnv }

export interface CommandResult {
  executable: string; args: string[]; cwd: string; exitCode: number | null;
  stdout: string; stderr: string; durationMs: number; error?: string; cleanupFailed?: true;
  /** Historical PID of the process created for this command, not a reusable kill capability. */
  ownedPid?: number;
  outputFiles?: {stdout:string;stderr:string};
  outputTruncated?: true;
}

export class ProcessCleanupError extends Error {
  readonly code = 'PROCESS_CLEANUP_FAILED';
  readonly cleanupFailed = true;
  constructor(readonly result: CommandResult) {
    super(`Owned command cleanup was not confirmed${result.ownedPid ? ` (PID ${result.ownedPid})` : ''}; preserve ownership until reconciliation.`);
    this.name = 'ProcessCleanupError';
  }
}

const OUTPUT_LIMIT = 256 * 1024;

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/** Force cleanup only of the process/tree or POSIX group spawned for this command. */
async function stopOwnedTree(child: ChildProcess, closed: Promise<void>): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return waitForClose(closed, 1_000);
  if (process.platform === 'win32') {
    // Once the parent has disappeared, taskkill cannot establish ownership of its children.
    // Do not target a potentially reused PID or claim the missing tree was cleaned up.
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const treeStopped = await new Promise<boolean>(resolve => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, shell: false, timeout: 3_000, maxBuffer: 4_096,
      }, error => resolve(!error));
    });
    return await waitForClose(closed, 2_000) && treeStopped;
  }
  // detached:true created this process group; negative PID never refers to the caller's group.
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try { process.kill(-pid, signal); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  if (!signalGroup('SIGTERM')) return false;
  await waitForClose(closed, 500);
  if (!signalGroup('SIGKILL')) return false;
  return waitForClose(closed, 2_000);
}

export class ProcessRunner {
  async run(executable: string, args: string[], cwd: string, timeoutMs = 30_000, options: CommandOptions = {}): Promise<CommandResult> {
    const started = Date.now();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { executable, args, cwd, exitCode: null, stdout: '', stderr: '', durationMs: 0, error: 'invalid_timeout' };
    }
    if (options.signal?.aborted) return {executable,args,cwd,exitCode:null,stdout:'',stderr:'',durationMs:0,error:'cancelled'};
    const logFds: number[] = [];
    if (options.outputFiles) {
      try { logFds.push(openSync(options.outputFiles.stdout,'wx')); logFds.push(openSync(options.outputFiles.stderr,'wx')); }
      catch { for(const fd of logFds)closeSync(fd); return {executable,args,cwd,exitCode:null,stdout:'',stderr:'',durationMs:0,error:'log_open_error'}; }
    }
    return new Promise(resolve => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let retainedBytes = 0;
      let finished = false;
      let stopReason: 'timeout' | 'output_limit' | 'cancelled' | 'log_error' | undefined;
      let totalBytes = 0;
      let outputTruncated = false;
      let onAbort: (()=>void) | undefined;
      let processError: string | undefined;
      let ownedPid: number | undefined;
      let closeSignal!: () => void;
      const closed = new Promise<void>(done => { closeSignal = done; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null, error?: string, cleanupFailed = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if(onAbort)options.signal?.removeEventListener('abort',onAbort);
        for(const fd of logFds)closeSync(fd);
        resolve({ executable, args, cwd, exitCode, stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Date.now() - started,
          ...(ownedPid === undefined ? {} : { ownedPid }),
          ...(options.outputFiles ? {outputFiles:options.outputFiles} : {}), ...(outputTruncated ? {outputTruncated:true as const} : {}),
          ...(error ? { error } : {}), ...(cleanupFailed ? { cleanupFailed: true as const } : {}) });
      };
      let child: ReturnType<typeof spawn>;
      try {
        const childEnv: NodeJS.ProcessEnv = {...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: '0'};
        if (options.pathPrepend?.length) {
          const keys = Object.keys(childEnv).filter(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
          const key = keys[0] ?? 'PATH';
          const current = childEnv[key] ?? '';
          for (const duplicate of keys) delete childEnv[duplicate];
          childEnv[key] = [...options.pathPrepend, ...(current ? [current] : [])].join(path.delimiter);
        }
        child = spawn(executable, args, {
          cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
        });
        ownedPid = child.pid;
      } catch { finish(null, 'spawn_error'); return; }
      const stop = (reason: NonNullable<typeof stopReason>) => {
        if (finished || stopReason) return;
        stopReason = reason;
        clearTimeout(timer);
        void stopOwnedTree(child, closed).then(confirmed => {
          if (!confirmed) {
            // Return control while preserving the caller's lock through cleanupFailed.
            // These handles are ours; this does not terminate unknown descendant processes.
            child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          }
          finish(null, reason, !confirmed);
        }).catch(() => {
          child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          finish(null, reason, true);
        });
      };
      const capture = (target: Buffer[], chunk: Buffer, streamIndex: number) => {
        if (finished || stopReason) return;
        totalBytes += chunk.length;
        if (options.outputFiles) {
          // Complete check logs stay on disk; a bounded preview is returned to the agent.
          // The disk cap is separate from the preview cap and prevents unbounded local output.
          if(totalBytes > 64*1024*1024) {stop('output_limit');return;}
          try {writeSync(logFds[streamIndex]!,chunk);} catch {stop('log_error');return;}
        }
        const remaining = OUTPUT_LIMIT - retainedBytes;
        const keep = chunk.subarray(0, Math.max(0, remaining));
        if (keep.length) { target.push(Buffer.from(keep)); retainedBytes += keep.length; }
        if (chunk.length > remaining) { outputTruncated=true; if(!options.outputFiles)stop('output_limit'); }
      };
      child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk, 0));
      child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk, 1));
      child.on('error', error => { processError = `spawn_error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`; });
      child.on('close', (code, signal) => {
        closeSignal();
        if (!stopReason) finish(processError ? null : code,
          processError ?? (code === 0 ? undefined : signal ? `process_signal:${signal}` : `process_exit:${code}`));
      });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      onAbort=()=>stop('cancelled');
      options.signal?.addEventListener('abort',onAbort,{once:true});
      if(options.signal?.aborted)onAbort();
    });
  }
}
