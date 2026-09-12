import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.tsx'],bundle:true,outfile:'dist/app.js',jsx:'automatic',minify:true,legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'}});
await copyFile('index.html','dist/index.html');
