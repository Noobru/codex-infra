import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessRunner } from '../src/process.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

test('preserves real exit status and bounded stdout/stderr without stdin input', async () => {
  const runner = new ProcessRunner();
  const success = await runner.run(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("diagnostic");'], process.cwd());
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, 'ok');
  assert.equal(success.stderr, 'diagnostic');
  assert.equal(success.error, undefined);
  const failure = await runner.run(process.execPath, ['-e', 'process.exit(7);'], process.cwd());
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.error, 'process_exit:7');
});

test('timeout stops its live parent and child tree before returning', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexinfra-process-'));
  const pidFile = path.join(directory, 'pids.json');
  const parentFile = path.join(directory, 'parent.cjs');
  writeFileSync(parentFile, `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore',windowsHide:true});
    child.once('spawn', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid])));
    setInterval(() => {}, 1000);
  `);
  let pids: number[] = [];
  t.after(() => {
    // Cleanup is restricted to PIDs created by this fixture, even when an assertion fails.
    for (const pid of pids) {
      if (!alive(pid)) continue;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 }); } catch {}
      } else { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'codexinfra-process-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const result = await new ProcessRunner().run(process.execPath, [parentFile, pidFile], directory, 2_000);
  pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  assert.equal(result.exitCode, null);
  assert.equal(result.error, 'timeout');
  assert.equal(result.cleanupFailed, undefined);
  assert.equal(pids.length, 2);
  assert.equal(result.ownedPid, pids[0]);
  for (const pid of pids) assert.equal(alive(pid), false, `Owned fixture PID ${pid} is still active`);
});

test('output limit is not PASS and captured output never exceeds the shared 256 KiB cap', async () => {
  const result = await new ProcessRunner().run(process.execPath, ['-e', `
    process.stdout.write('x'.repeat(200000));
    process.stderr.write('y'.repeat(200000));
    setInterval(() => {}, 1000);
  `], process.cwd(), 10_000);
  assert.equal(result.exitCode, null);
  assert.equal(result.error, 'output_limit');
  assert.equal(result.cleanupFailed, undefined);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 256 * 1024);
});

test('complete logs stay on disk while verbose successful checks return bounded previews',async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'codexinfra-logs-'));
  t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'codexinfra-logs-'));rmSync(directory,{recursive:true,force:true});});
  const outputFiles={stdout:path.join(directory,'stdout.log'),stderr:path.join(directory,'stderr.log')};
  const result=await new ProcessRunner().run(process.execPath,['-e',`process.stdout.write('x'.repeat(400000));process.stderr.write('end');`],directory,10000,{outputFiles});
  assert.equal(result.exitCode,0); assert.equal(result.outputTruncated,true);
  assert.equal(readFileSync(outputFiles.stdout).length,400000);
  assert.equal(readFileSync(outputFiles.stderr,'utf8'),'end');
  assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=256*1024);
});

test('abort stops the owned long-running check before its configured timeout',async()=>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),300);
  try {
    const result=await new ProcessRunner().run(process.execPath,['-e','setInterval(()=>{},1000)'],process.cwd(),60000,{signal:controller.signal});
    assert.equal(result.error,'cancelled'); assert.equal(result.cleanupFailed,undefined);
    assert.equal(alive(result.ownedPid!),false);
  }finally{clearTimeout(timer);}
});

test('child resolves an executable from its PATH prefix without changing the host environment',async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'codexinfra-path-'));
  t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'codexinfra-path-'));rmSync(directory,{recursive:true,force:true});});
  const name=process.platform==='win32'?'codexinfra-fixture-runtime.cmd':'codexinfra-fixture-runtime';
  const executable=path.join(directory,name);
  writeFileSync(executable,process.platform==='win32'?'@exit /b 0\r\n':'#!/bin/sh\nexit 0\n',{mode:0o755});
  const previous={...process.env};
  const result=await new ProcessRunner().run(process.execPath,['-e',`
    const {spawnSync}=require('node:child_process');
    const path=require('node:path');
    const found=spawnSync(process.platform==='win32'?'where.exe':'which',[process.argv[1]],{encoding:'utf8',shell:false,windowsHide:true});
    const key=Object.keys(process.env).find(key=>process.platform==='win32'?key.toLowerCase()==='path':key==='PATH');
    process.stdout.write(JSON.stringify({prefix:process.env[key].split(path.delimiter)[0],found:found.stdout.trim(),status:found.status}));
  `,name],process.cwd(),10000,{pathPrepend:[directory]});
  assert.equal(result.exitCode,0);
  const captured=JSON.parse(result.stdout);
  assert.equal(captured.prefix,directory);
  assert.equal(captured.found,executable);
  assert.equal(captured.status,0);
  assert.deepEqual({...process.env},previous);
});
