#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GIdeiaBootstrap} from '../dist/src/g-ideia-bootstrap.js';
import {readJson} from '../dist/src/legacy/command-os-utils.js';

const args=process.argv.slice(2);
const help='Usage: node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json [--apply]\nDefault: read-only metadata plan. --apply explicitly installs/preserves the vault contract and creates or binds project notes/profile. No checks or models run.';
if(args.includes('--help')){console.log(help);process.exit(0);}
try{
  const inputIndex=args.indexOf('--input');
  if(inputIndex<0||!args[inputIndex+1]||args[inputIndex+1].startsWith('--')
    ||args.some((value,index)=>index!==inputIndex&&index!==inputIndex+1&&value!=='--apply')
    ||args.filter(value=>value==='--apply').length>1)throw new Error(help);
  const input=await readJson(path.resolve(args[inputIndex+1]),null);
  if(!input)throw new Error('Input JSON is missing or empty. '+help);
  const infraRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const bootstrap=new GIdeiaBootstrap(infraRoot);
  const result=args.includes('--apply')?await bootstrap.apply(input):await bootstrap.plan(input);
  console.log(JSON.stringify(result,null,2));
  if('ready' in result&&!result.ready)process.exitCode=2;
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
