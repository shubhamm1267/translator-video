// End-to-end through actual Node HTTP endpoints + FFmpeg. Gemini & Cartesia mocked.
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cmd, probe } from '../src/media.mjs';
import { CFG } from '../src/env.mjs';
const tmp=await mkdtemp(join(tmpdir(),'cc-http-'));
const port=33513;
let server;
try {
  const file=join(tmp,'clip.mp4'), wav=join(tmp,'voice.wav');
  const trace=join(tmp,'mock.log');
  await cmd(CFG.ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=256x456:rate=20:duration=9','-c:v','libx264','-preset','ultrafast','-crf','30',file]);
  await cmd(CFG.ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=450:duration=7.6:sample_rate=44100','-c:a','pcm_s16le',wav]);
  server=spawn(process.execPath,['--import','./scripts/mock-providers.mjs','src/server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),GEMINI_API_KEY:'mock-key',CARTESIA_API_KEY:'mock-key',MOCK_CARTESIA_WAV_PATH:wav,MOCK_TRACE:trace},stdio:['ignore','pipe','pipe']});
  let stderr='';server.stderr.on('data',x=>{stderr+=x.toString();});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let k=0;k<50;k++){
    try{const r=await fetch(`${base}/api/health`);if(r.ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,120));
  }
  if(!ready)throw new Error('API server failed to start: '+stderr);
  const voiceRes = await fetch(`${base}/api/voices`);
  const voiceData = await voiceRes.json();
  if (!voiceRes.ok || voiceData.voices.length !== 2) throw new Error('Both language voice groups missing');
  if (!voiceData.voices.find(v => v.language === 'hi' && v.locale === 'hi-IN')) throw new Error('Hindi voice missing');
  if (!voiceData.voices.find(v => v.language === 'en' && v.locale === 'en-US')) throw new Error('English voice missing');
  const options={review:true,language:'en',voiceId:'voice-english',tone:'funny',watermark:'e2e TEST',opacity:55,captions:true,cta:true,coverOriginalCaptions:true};
  const req=await fetch(`${base}/api/jobs`,{method:'POST',headers:{'Content-Type':'video/mp4','X-Options':Buffer.from(JSON.stringify(options)).toString('base64url')},body:await import('node:fs').then(fs=>fs.createReadStream(file)),duplex:'half'});
  const result=await req.json();if(req.status!==202)throw new Error('API upload failed '+JSON.stringify(result));
  let j;
  for(let i=0;i<100;i++){
    await new Promise(r=>setTimeout(r,400));
    j=await (await fetch(`${base}/api/jobs/${result.id}`)).json();
    if(j.status==='done'||j.status==='error'||j.status==='review')break;
  }
  if(j?.status!=='review')throw new Error('Initial AI review did not finish '+JSON.stringify(j)+' stderr: '+stderr);
  const originalHook=j.script.hook;
  const revision=await fetch(`${base}/api/jobs/${result.id}/regenerate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({options})});
  if(revision.status!==202)throw new Error('regenerate endpoint error '+await revision.text());
  for(let i=0;i<100;i++){
    await new Promise(r=>setTimeout(r,150));
    j=await (await fetch(`${base}/api/jobs/${result.id}`)).json();
    if(['review','error'].includes(j.status))break;
  }
  if(j.status!=='review'||j.script.hook===originalHook||j.scriptRevision!==2)throw new Error('Regenerate did not give a new script: '+JSON.stringify(j));
  const traceText=await readFile(trace,'utf8');
  if(traceText.split('UPLOAD').length!==2||traceText.split('ANALYZE').length!==2)throw new Error('Regeneration retransmitted video! '+traceText);
  const render=await fetch(`${base}/api/jobs/${result.id}/render`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({script:j.script,options})});
  if(render.status!==202)throw new Error('render endpoint error '+await render.text());
  for(let i=0;i<100;i++){
    await new Promise(r=>setTimeout(r,400));
    j=await (await fetch(`${base}/api/jobs/${result.id}`)).json();
    if(j.status==='done'||j.status==='error')break;
  }
  if(j.status!=='done')throw new Error('Final render did not complete '+JSON.stringify(j)+' stderr: '+stderr);
  for(const [kind,ctype] of [['video','video/mp4'],['metadata','text/plain'],['captions','text/plain']]){
    const r=await fetch(`${base}/api/jobs/${result.id}/file/${kind}`);
    if(!r.ok || !r.headers.get('content-type').includes(ctype))throw new Error(`${kind} download failed`);
    if(kind==='metadata' && !(await r.text()).includes('Another real reveal'))throw new Error('Missing metadata title');
    else if(kind==='video' && (await r.arrayBuffer()).byteLength<50000)throw new Error('Video unexpectedly small');
  }
  console.log(`PASS: Single video analysis → AI script regeneration without reupload → continuous Cartesia voice → FFmpeg MP4, captions, metadata.`);
}finally{
  if(server){server.kill('SIGTERM');await new Promise(r=>setTimeout(r,250));}
  await rm(tmp,{recursive:true,force:true});
}
