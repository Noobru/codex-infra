import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KnowledgeFiles } from './knowledge-store.js';
import { EvidenceSanitizer } from './evidence.js';
import { ProcessRunner, type CommandResult } from './process.js';
import { resolveRealSubPath } from './legacy/command-os-utils.js';
import type { LearningSandboxExecutor, LearningSandboxRequest } from './learning-runtime.js';

const images = { node: 'node:22.23.2-bookworm-slim', python: 'python:3.13.15-slim-bookworm' };
const proofSchema = z.object({ inside: z.literal(true), outside: z.enum(['EACCES', 'EPERM', 'EROFS']),
  interfaces: z.array(z.string()).refine(value => value.length > 0 && value.every(name => name === 'lo')),
  network: z.enum(['ECONNREFUSED', 'EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH']) });
export interface LearningSandboxOptions { dockerPath?: string; images?: Partial<typeof images> }
export interface LearningSandboxAvailability { available: boolean; reason?: string; imageId?: string; endpoint?: string }

/** Uses an already running local Docker engine. Never starts Docker/WSL, pulls images, mounts credentials or runs a model. */
export class LearningSandbox implements LearningSandboxExecutor {
  private readonly runner = new ProcessRunner();
  private readonly files: KnowledgeFiles;
  private readonly docker: string;
  constructor(readonly root: string, private readonly options: LearningSandboxOptions = {}) {
    this.files = new KnowledgeFiles(root); this.docker = options.dockerPath ?? (process.platform === 'win32' ? 'docker.exe' : 'docker');
  }

  /** Read-only availability check, suitable before spending a model turn on a generated capability. */
  async available(runtime: 'node' | 'python' = 'node'): Promise<LearningSandboxAvailability> {
    try {
      const endpointResult = await this.command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
      const endpoint = endpointResult.stdout.trim();
      if (endpointResult.exitCode !== 0 || !/^(?:npipe:\/\/\/\/\.\/pipe\/[\w.-]+|unix:\/[^\r\n]+)$/.test(endpoint))
        return { available: false, reason: 'A local Docker socket or named-pipe context is required; remote engines are not allowed.' };
      const prefix = this.prefix(endpoint), info = await this.command([...prefix, 'info', '--format', '{{.OSType}}']);
      if (info.exitCode !== 0 || info.stdout.trim() !== 'linux') return { available: false, reason: 'A local Linux Docker engine must already be running; this adapter never starts it.' };
      const selected = this.options.images?.[runtime] ?? images[runtime];
      const image = await this.command([...prefix, 'image', 'inspect', selected, '--format', '{{.Id}}']);
      const imageId = image.stdout.trim();
      if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
        return { available: false, reason: `Required local ${runtime} image is unavailable; no pull was attempted.` };
      return { available: true, endpoint, imageId };
    } catch (error) { return { available: false, reason: this.error(error) }; }
  }

  async run(request: LearningSandboxRequest) {
    const workspace = await this.workspace(request);
    const available = await this.available(request.runtime);
    if (!available.available || !available.endpoint || !available.imageId) throw new Error(available.reason ?? 'Learning sandbox unavailable.');
    const id = randomUUID(), name = `codex-infra-learning-${id}`, prefix = this.prefix(available.endpoint), user = this.containerUser();
    const entrypoint = '/workspace/' + path.relative(workspace, await fs.realpath(request.entrypoint)).replaceAll('\\', '/');
    const createArgs = [...prefix, 'create', '--pull', 'never', '--name', name, '--label', `codex-infra-learning=${id}`,
      '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--user', user,
      '--mount', `type=bind,src=${workspace},dst=/workspace`, '--workdir', '/workspace',
      '--env', 'HOME=/workspace', '--env', 'TMPDIR=/workspace', '--env', 'PYTHONDONTWRITEBYTECODE=1',
      '--entrypoint', '/bin/sleep', available.imageId, String(Math.ceil((request.timeoutMs + 30000) / 1000))];
    let created = false, result: CommandResult | undefined, failure: unknown, cleanup = false;
    let proof: z.output<typeof proofSchema> | undefined, policyObserved: unknown;
    const artifactPath = `artifacts/learning/runtime/isolation/${id}.json`;
    try {
      const container = await this.command(createArgs);
      created = container.exitCode === 0 && /^[a-f0-9]{64}$/.test(container.stdout.trim());
      if (!created) throw new Error(`Learning container could not be created: ${EvidenceSanitizer.text(container.stderr, 500)}`);
      const inspection = await this.command([...prefix, 'inspect', name, '--format', '{{json .}}']);
      if (inspection.exitCode !== 0) throw new Error('Learning container policy could not be inspected.');
      const inspected = JSON.parse(inspection.stdout);
      if (inspected.Config?.Labels?.['codex-infra-learning'] !== id || inspected.Image !== available.imageId
        || inspected.HostConfig?.NetworkMode !== 'none' || inspected.HostConfig?.ReadonlyRootfs !== true
        || inspected.Config?.User !== user || inspected.HostConfig?.Privileged !== false
        || inspected.HostConfig?.CapDrop?.includes('ALL') !== true
        || inspected.HostConfig?.SecurityOpt?.includes('no-new-privileges') !== true
        || inspected.Mounts?.length !== 1 || inspected.Mounts[0]?.Destination !== '/workspace')
        throw new Error('Learning container does not match the required isolation policy.');
      policyObserved = { imageId: inspected.Image, networkMode: inspected.HostConfig.NetworkMode, readOnlyRoot: inspected.HostConfig.ReadonlyRootfs,
        user: inspected.Config.User, capDrop: inspected.HostConfig.CapDrop, securityOpt: inspected.HostConfig.SecurityOpt, mounts: 1 };
      const start = await this.command([...prefix, 'start', name]);
      if (start.exitCode !== 0) throw new Error('Learning container could not start.');
      proof = await this.probe(prefix, name, id, request.runtime, workspace, request.signal);
      if (request.signal?.aborted) throw new Error('Learning execution cancelled before entrypoint.');
      const runtimeArgs = request.runtime === 'node' ? ['/usr/local/bin/node', entrypoint, ...request.args]
        : ['/usr/local/bin/python3', '-I', '-B', entrypoint, ...request.args];
      result = await this.command([...prefix, 'exec', name, ...runtimeArgs], request.timeoutMs, request.signal);
    } catch (error) { failure = error; }
    finally { cleanup = await this.cleanup(prefix, name, id); }
    await this.files.writeJsonNew(artifactPath, { version: 1, id, recordedAt: new Date().toISOString(), kind: 'docker-local-network-none',
      imageId: available.imageId, runtime: request.runtime, policyObserved: policyObserved ?? null, probe: proof ?? null,
      cleanupConfirmed: cleanup, passed: !!proof && !failure && cleanup, error: failure ? this.error(failure) : null,
      limitations: ['No host directories except the materialized workspace are mounted. Network proof combines the inspected network namespace with an owned loopback connection and observed interfaces.',
        'Docker must already be active and its local image trusted; this is not a virtual machine for hostile code.'] });
    if (failure || !proof || !result) throw new Error(`${failure ? this.error(failure) : 'Learning isolation was not verified.'} Evidence: ${artifactPath}${cleanup ? '' : ' Owned container cleanup is unconfirmed.'}`);
    if (!cleanup) result = { ...result, cleanupFailed: true, error: 'learning_container_cleanup_unconfirmed' };
    return { result, isolation: { kind: 'docker-local-network-none', network: 'denied' as const, filesystem: 'workspace-write' as const,
      verified: true as const, evidence: [artifactPath] } };
  }

  private async workspace(request: LearningSandboxRequest): Promise<string> {
    if (!['node', 'python'].includes(request.runtime) || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 120000)
      throw new Error('Learning sandbox requires a supported runtime and a timeout between 100 and 120000 ms.');
    if (request.signal?.aborted) throw new Error('Learning sandbox cancelled before preparation.');
    if (request.args.length > 100 || request.args.some(value => typeof value !== 'string' || value.length > 8000 || value.includes('\0')
      || path.isAbsolute(value) || path.win32.isAbsolute(value))) throw new Error('Capability arguments must use portable relative workspace paths, not host absolute paths.');
    const workspace = await resolveRealSubPath(request.workspace, path.join(this.root, 'artifacts/learning/runtime/workspaces'));
    if (!workspace || workspace.includes(',') || workspace.includes('\n')) throw new Error('Sandbox workspace must be a materialized capability directory.');
    const entrypoint = await resolveRealSubPath(request.entrypoint, workspace);
    if (!entrypoint || !(await fs.stat(entrypoint)).isFile()) throw new Error('Learning entrypoint must be a file inside its materialized workspace.');
    return workspace;
  }

  private async probe(prefix: string[], container: string, id: string, runtime: 'node' | 'python', workspace: string, signal?: AbortSignal) {
    const listener = net.createServer(socket => socket.end());
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    try {
      const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Owned isolation listener unavailable.');
      // First prove the host listener is reachable. The sandbox must not be able to reach this same loopback socket.
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(address.port, '127.0.0.1'); socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
        socket.once('timeout', () => { socket.destroy(); reject(new Error('Owned loopback control timed out.')); });
      });
      const marker = `.isolation-${id}.txt`;
      const nodeCode = `const fs=require('node:fs'),os=require('node:os'),net=require('node:net');const r={};fs.writeFileSync(${JSON.stringify(marker)},'inside');r.inside=true;try{fs.writeFileSync('/outside-${id}','bad');r.outside='allowed'}catch(e){r.outside=e.code}r.interfaces=Object.keys(os.networkInterfaces());const s=net.connect(${address.port},'127.0.0.1');s.setTimeout(1000);s.on('connect',()=>{r.network='allowed';s.destroy()});s.on('error',e=>{r.network=e.code});s.on('timeout',()=>{r.network='timeout';s.destroy()});s.on('close',()=>console.log(JSON.stringify(r)));`;
      const pythonCode = `import json,socket,errno\nr={}\nwith open(${JSON.stringify(marker)},'w') as f:f.write('inside')\nr['inside']=True\ntry:\n with open('/outside-${id}','w') as f:f.write('bad')\n r['outside']='allowed'\nexcept OSError as e:r['outside']=errno.errorcode.get(e.errno,str(e.errno))\nr['interfaces']=[name for _,name in socket.if_nameindex()]\ns=socket.socket();s.settimeout(1)\ntry:\n s.connect(('127.0.0.1',${address.port}));r['network']='allowed'\nexcept OSError as e:r['network']=errno.errorcode.get(e.errno,str(e.errno))\nfinally:s.close()\nprint(json.dumps(r))`;
      const args = runtime === 'node' ? ['/usr/local/bin/node', '-e', nodeCode] : ['/usr/local/bin/python3', '-I', '-B', '-c', pythonCode];
      const observed = await this.command([...prefix, 'exec', container, ...args], 10000, signal);
      if (observed.exitCode !== 0 || observed.error || observed.cleanupFailed) throw new Error(`Isolation probe did not complete: ${EvidenceSanitizer.text(observed.stderr, 400)}`);
      const proof = proofSchema.parse(JSON.parse(observed.stdout));
      if (await fs.readFile(path.join(workspace, marker), 'utf8') !== 'inside') throw new Error('Sandbox workspace write did not reach its declared owned mount.');
      return proof;
    } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  }

  private async cleanup(prefix: string[], name: string, id: string): Promise<boolean> {
    const existing = await this.command([...prefix, 'container', 'ls', '-aq', '--filter', `name=^/${name}$`]);
    if (existing.exitCode !== 0) return false;
    if (!existing.stdout.trim()) return true;
    const owner = await this.command([...prefix, 'inspect', name, '--format', '{{index .Config.Labels "codex-infra-learning"}}']);
    if (owner.exitCode !== 0 || owner.stdout.trim() !== id) return false;
    // The exact generated name and label prove ownership, including a create timeout before its ID reached the client.
    const removed = await this.command([...prefix, 'rm', '--force', name]);
    const remaining = await this.command([...prefix, 'container', 'ls', '-aq', '--filter', `name=^/${name}$`]);
    return removed.exitCode === 0 && remaining.exitCode === 0 && !remaining.stdout.trim();
  }

  private prefix(endpoint: string): string[] { return ['--host', endpoint, '--config', path.join(this.root, 'artifacts/learning/runtime/docker-client')]; }
  private containerUser(): string {
    // Native Linux binds preserve ownership; match the non-root host user so the fresh workspace stays writable.
    return process.platform === 'linux' && process.getuid && process.getgid && process.getuid() > 0 ? `${process.getuid()}:${process.getgid()}` : '65534:65534';
  }
  private command(args: string[], timeoutMs = 10000, signal?: AbortSignal): Promise<CommandResult> {
    const keep = new Set(['systemroot', 'windir', 'comspec', 'path', 'userprofile', 'homedrive', 'homepath', 'home']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key.toLowerCase())));
    return this.runner.run(this.docker, args, this.root, timeoutMs, { signal, env });
  }
  private error(error: unknown): string { return EvidenceSanitizer.text(error instanceof Error ? error.message : 'Learning sandbox failed.', 1000); }
}
