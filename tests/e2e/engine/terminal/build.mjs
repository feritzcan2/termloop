import {build} from 'esbuild';
await build({entryPoints:['renderer.mjs'],outfile:'renderer.js',bundle:true,platform:'browser',format:'esm',loader:{'.css':'css','.ttf':'file'}});
