import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface AppServerOptions {
  /** Reuse the host's existing GitHub CLI login in this child only. Never persisted. */
  gitHubAuth?: boolean;
  githubTokenProvider?: () => Promise<string>;
  codexPath?: string;
  cwd?: string;
  requestTimeoutMs?: number;
  /** Complete transport override for deterministic subprocess tests. */
  command?: string;
  args?: string[];
}

export interface ServerRequestNotice {
  method: string;
  message: string;
}

export class AppServerError extends Error {
  constructor(message: string, readonly code: number | string, readonly method?: string) {
    super(message);
    this.name = 'AppServerError';
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const require = createRequire(import.meta.url);

/** Resolve the locally installed native binary, never a global shim or shell. */
export function localCodexBinary(): string {
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[process.arch as 'x64' | 'arm64'];
  const system = { win32: 'pc-windows-msvc', linux: 'unknown-linux-musl', darwin: 'apple-darwin' }[
    process.platform as 'win32' | 'linux' | 'darwin'
  ];
  if (!cpu || !system) throw new AppServerError('Unsupported Codex runtime platform.', 'BINARY_UNAVAILABLE');
  const triple = `${cpu}-${system}`;
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const roots: string[] = [];
  try {
    roots.push(path.join(path.dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)), 'vendor'));
  } catch { /* Older packages carry the platform binary in the main package. */ }
  try {
    roots.push(path.join(path.dirname(require.resolve('@openai/codex/package.json')), 'vendor'));
  } catch { /* The caller receives one installation diagnostic below. */ }
  for (const root of roots) {
    const candidate = path.join(root, triple, 'bin', executable);
    if (existsSync(candidate)) return candidate;
  }
  throw new AppServerError('Local Codex binary unavailable; restore the pinned local dependencies.', 'BINARY_UNAVAILABLE');
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:key|token|secret|password|credential)/i.test(key)
    && !/^(OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/i.test(key)));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function quotaWindow(value: unknown): Record<string, number | null> | null {
  const source = object(value);
  if (!source) return null;
  return Object.fromEntries(['usedPercent', 'windowDurationMins', 'resetsAt'].map(key =>
    [key, typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : null]));
}

function quotaBucket(value: unknown): Record<string, unknown> | null {
  const source = object(value);
  if (!source) return null;
  return {
    limitId: typeof source.limitId === 'string' ? source.limitId : null,
    limitName: typeof source.limitName === 'string' ? source.limitName : null,
    planType: typeof source.planType === 'string' ? source.planType : null,
    primary: quotaWindow(source.primary), secondary: quotaWindow(source.secondary),
    rateLimitReachedType: typeof source.rateLimitReachedType === 'string' ? source.rateLimitReachedType : null,
  };
}

export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private state: 'new' | 'connecting' | 'connected' | 'closed' = 'new';
  private connecting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private exited: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifications = new Set<(method: string, params: any) => void>();
  private serverRequests = new Set<(notice: ServerRequestNotice) => void>();
  private buffer = '';
  private decoder = new StringDecoder('utf8');

  constructor(private readonly options: AppServerOptions = {}) {
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('requestTimeoutMs must be positive.');
    if (options.args && !options.command) throw new Error('args requires an explicit transport command.');
  }

  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(new AppServerError('App Server client is closed.', 'CLOSED'));
    if (this.connecting) return this.connecting;
    this.connecting = this.start();
    return this.connecting;
  }

  private async start(): Promise<void> {
    this.state = 'connecting';
    try {
      const command = this.options.command ?? this.options.codexPath ?? localCodexBinary();
      const args = this.options.command ? this.options.args ?? [] : [
        'app-server', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      ];
      const env = childEnvironment();
      if (this.options.gitHubAuth) {
        const token = await (this.options.githubTokenProvider ?? (() => new Promise<string>((resolve, reject) => {
          execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env },
            (error, stdout) => error ? reject(new AppServerError('Existing GitHub CLI authentication is unavailable.', 'GITHUB_AUTH_UNAVAILABLE')) : resolve(stdout.trim()));
        })))();
        if (!token || /[\r\n]/.test(token)) throw new AppServerError('Existing GitHub CLI authentication is unavailable.', 'GITHUB_AUTH_UNAVAILABLE');
        env.GH_TOKEN = token;
      }
      const child = spawn(command, args, {
        cwd: this.options.cwd, env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.exited = new Promise(resolve => child.once('close', () => resolve()));
      child.on('error', () => this.fail(new AppServerError('App Server process could not start.', 'PROCESS_ERROR')));
      child.on('exit', code => this.fail(new AppServerError(`App Server exited (code ${code ?? 'signal'}).`, 'PROCESS_EXIT')));
      child.stdout.on('data', (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
      child.stdout.on('error', () => this.fail(new AppServerError('App Server output stream failed.', 'TRANSPORT_ERROR')));
      child.stdin.on('error', () => this.fail(new AppServerError('App Server input stream failed.', 'TRANSPORT_ERROR')));
      // Drain stderr without retaining it: runtime logs may contain account or filesystem details.
      child.stderr.on('data', () => {});
      child.stderr.on('error', () => {});
      await this.sendRequest('initialize', {
        clientInfo: { name: 'codex_infra', title: 'CodexInfra', version: '0.1.0' },
      });
      this.send({ method: 'initialized', params: {} });
      this.state = 'connected';
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'connected') return Promise.reject(new AppServerError('Connect App Server before requesting work.', 'NOT_CONNECTED'));
    return this.sendRequest(method, params) as Promise<T>;
  }

  onNotification(listener: (method: string, params: any) => void): () => void {
    this.notifications.add(listener);
    return () => { this.notifications.delete(listener); };
  }

  /** Observational only: requests are rejected, and no approval response can be granted here. */
  onServerRequest(listener: (notice: ServerRequestNotice) => void): () => void {
    this.serverRequests.add(listener);
    return () => { this.serverRequests.delete(listener); };
  }

  async probeAccount(): Promise<{ type: string | null; planType?: string; rateLimits: unknown }> {
    await this.connect();
    const result = await this.request<{ account: unknown }>('account/read', { refreshToken: false });
    const account = object(result.account);
    if (!account) return { type: null, rateLimits: null };
    if (account.type !== 'chatgpt') throw new AppServerError('A saved ChatGPT login is required; API-key and other auth modes are not permitted.', 'AUTH_MODE_REFUSED');
    const quota = await this.request<Record<string, unknown>>('account/rateLimits/read');
    const byId = object(quota.rateLimitsByLimitId);
    return {
      type: 'chatgpt',
      ...(typeof account.planType === 'string' ? { planType: account.planType } : {}),
      rateLimits: {
        rateLimits: quotaBucket(quota.rateLimits),
        rateLimitsByLimitId: byId ? Object.fromEntries(Object.entries(byId).map(([id, bucket]) => [id, quotaBucket(bucket)])) : null,
      },
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    this.fail(new AppServerError('App Server client closed.', 'CLOSED'));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(1_000)) return;
    if (process.platform === 'win32') {
      // Restrict forced cleanup to the still-live process this instance spawned.
      // Root interrupts active turns first; this handles an unresponsive transport.
      const pid = child.pid;
      if (pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true, shell: false, timeout: 3_000, maxBuffer: 4_096,
          }, () => resolve());
        });
      }
    } else {
      child.kill('SIGTERM');
      if (await this.waitForExit(1_000)) return;
      child.kill('SIGKILL');
    }
    if (!await this.waitForExit(2_000)) {
      throw new AppServerError('Owned App Server process did not exit; cleanup requires inspection.', 'CLEANUP_FAILED');
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.exited?.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`App Server request timed out: ${method}.`, 'REQUEST_TIMEOUT', method));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  private send(message: unknown): void {
    if (!this.child || this.state === 'closed') throw new AppServerError('App Server transport is closed.', 'CLOSED');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    if (this.state === 'closed') return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.protocolFailure(); return; }
      let message: Record<string, unknown> | null;
      try { message = object(JSON.parse(line)); } catch { this.protocolFailure(); return; }
      if (!message) { this.protocolFailure(); return; }
      if (typeof message.method === 'string') {
        if (typeof message.id === 'number' || typeof message.id === 'string') {
          const notice = { method: message.method, message: 'Server request declined: explicit user input or authorization is required.' };
          this.send({ id: message.id, error: { code: -32004, message: notice.message } });
          for (const listener of this.serverRequests) this.callListener(() => listener(notice));
          this.emit('client/serverRequestRejected', notice);
        } else { this.emit(message.method, message.params); }
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) {
          const code = object(message.error)?.code;
          pending.reject(new AppServerError(`App Server request failed: ${pending.method} (code ${typeof code === 'number' ? code : 'unknown'}).`, typeof code === 'number' ? code : 'RPC_ERROR', pending.method));
        } else if ('result' in message) { pending.resolve(message.result); }
        else { pending.reject(new AppServerError('Malformed App Server response.', 'PROTOCOL_ERROR', pending.method)); }
      } else { this.protocolFailure(); return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) this.protocolFailure();
  }

  private protocolFailure(): void {
    this.buffer = '';
    this.fail(new AppServerError('Invalid App Server JSONL output.', 'PROTOCOL_ERROR'));
    // Keep the parent alive until the canonical close path can stop its tree.
    // The cached rejection remains observable to the owner's awaited close().
    void this.close().catch(() => {});
  }

  private fail(error: Error): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('client/disconnected', { message: error.message });
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.notifications) this.callListener(() => listener(method, params));
  }

  private callListener(callback: () => void): void {
    try { callback(); } catch { /* A UI observer cannot corrupt pending transport requests. */ }
  }
}
