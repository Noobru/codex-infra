import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskEngine} from '../dist/src/engine.js';
import {ExecutionPolicyManager} from '../dist/src/execution-policy.js';
import {atomicWriteJson, atomicWriteNew} from '../dist/src/legacy/command-os-utils.js';

const root=await fs.realpath(path.resolve(fileURLToPath(new URL('..',import.meta.url))));
await fs.mkdir(path.join(root,'profiles'),{recursive:true});
const engine=new TaskEngine(root);
try {
  const node=process.execPath;
  const check=(id,args,relativeCwd='.')=>({id,executable:node,args,relativeCwd,readOnly:false,timeoutMs:600000});
  await engine.profiles.register({id:'codex-infra',name:'CodexInfra',aliases:[],root,status:'active',stack:['Node.js','TypeScript','SQLite','React'],
    modes:['read-only','workspace-write'],workspaces:['in-place','worktree'],sourceRoots:[],
    sources:[{path:'README.md',label:'Readme',kind:'reference',maxChars:12000},{path:'docs/USO.md',label:'Operation',kind:'reference',maxChars:12000}],
    checks:[check('build',['node_modules/typescript/bin/tsc','-p','tsconfig.json']),
      // Each file owns subprocess fixtures; run files serially to avoid host startup contention.
      check('tests',['--test','--test-concurrency=1','dist/test/*.test.js']),
      check('ui-typecheck',['../node_modules/typescript/bin/tsc','-p','tsconfig.json'],'ui'),
      check('ui-build',['build.mjs'],'ui')]});
  const policyPath=path.join(root,'profiles/execution-policy.json');
  try {await fs.access(policyPath);} catch(error) {
    if(error.code!=='ENOENT')throw error;
    await new ExecutionPolicyManager(root,engine.profiles,engine.state).configure({version:1,maxWorkers:2,maxModelWorkers:1});
  }
  await atomicWriteJson(path.join(root,'plugins/codex-infra/.mcp.json'),{mcpServers:{'codex-infra':{command:node,args:[path.join(root,'dist/src/mcp.js')],env:{CODEX_INFRA_ROOT:root}}}});
  const adoption='# Instalação local\n\nRaiz do CodexInfra: `'+root+'`.\n\nUse o MCP codex-infra e a skill start-project. Fallback CLI: Node `'+node+'`, entrada `'+path.join(root,'dist/src/cli.js')+'`.\n\nIncorpore docs/ADOPTION.md ao contrato global existente quando solicitado pelo usuário. Não substitua instruções pessoais nem registre este arquivo no Git.\n';
  try {await atomicWriteNew(path.join(root,'docs/LOCAL-ADOPTION.md'),adoption);} catch(error) {if(error.code!=='EEXIST')throw error;}
  console.log(JSON.stringify({configured:true,registeredProject:'codex-infra',mcpConfig:'plugins/codex-infra/.mcp.json',adoption:'docs/LOCAL-ADOPTION.md',modelsStarted:0}));
} finally {engine.close();}
