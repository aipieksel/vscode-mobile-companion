#!/usr/bin/env node
/** Offline browser fixture. No VS Code, provider, account, or relay is contacted.
 * Usage: node scripts/smoke-server.js [port] (default 18767).
 * The served app.js uses this fixture port and scans only this fixture server.
 * The actual browser source and production default ports are unchanged.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[2] || 18767);
const root = path.resolve(__dirname, '../project/browser');
const messages = [
  {role:'user', provider:'fixture', content:'Summarize this example project.', timestamp:'2026-01-01T12:00:00Z'},
  {role:'assistant', provider:'fixture', content:'This is synthetic browser test data. No AI provider was called.', timestamp:'2026-01-01T12:00:01Z'},
];
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(data));}
http.createServer((req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});res.end();return;}
  if(url.pathname==='/health')return json(res,200,{status:'ok',version:'synthetic-fixture',capabilities:{providersAvailable:['copilot'],connected:true}});
  if(url.pathname==='/workspace-info')return json(res,200,{workspaceName:'Example Project',workspacePath:'/workspace/example',folders:[{id:'example',name:'Example Project',path:'/workspace/example'}]});
  if(url.pathname==='/transcript')return json(res,200,{messages,sessionId:'synthetic-session'});
  if(url.pathname==='/chat'&&req.method==='POST'){
    let body='';req.on('data',chunk=>{body+=chunk});req.on('end',()=>{
      try{const data=JSON.parse(body);if(!data.message?.trim())return json(res,400,{error:'message is required'});
        messages.push({role:'user',provider:'fixture',content:data.message,timestamp:new Date().toISOString()},{role:'assistant',provider:'fixture',content:'Synthetic reply received. No external action performed.',timestamp:new Date().toISOString()});return json(res,200,{ok:true});
      }catch{return json(res,400,{error:'Invalid JSON'});}
    });return;
  }
  let name;try{name=decodeURIComponent(url.pathname)}catch{res.writeHead(400);res.end();return;}
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,bytes)=>{
    if(error){res.writeHead(404);res.end('Not found');return;}
    if(file===path.join(root,'app.js'))bytes=Buffer.from(bytes.toString().replace('const BASE_PORT = 8767;',`const BASE_PORT = ${port};`).replace('const MAX_PORT_SCAN = 6;','const MAX_PORT_SCAN = 1;'));
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
  });
}).listen(port,'127.0.0.1',()=>console.log(`Synthetic browser fixture: http://127.0.0.1:${port}`));
