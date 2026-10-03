import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmd, probe, renderVideo, assembleNarration } from '../src/media.mjs';
import { CFG } from '../src/env.mjs';

const dir = await mkdtemp(join(tmpdir(),'clipcraft-render-'));
try {
  const video = join(dir,'fixture.mp4');
  await cmd(CFG.ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=360x640:rate=30:duration=9','-f','lavfi','-i','sine=frequency=200:sample_rate=44100:duration=9','-c:v','libx264','-preset','ultrafast','-crf','28','-c:a','aac','-shortest',video],{timeoutMs:35000});
  const info = await probe(video);
  const script={language:'en',summary:'Local test fixture, no AI',hook:'A rendering test',beats:[{start:0,end:3,text:'Testing our scene one'},{start:3,end:6,text:'This is scene two'},{start:6,end:9,text:'Now the final scene'}],metadata:{title:'Demo test',description:'Renderer test only',tags:['testing']}};
  // Production now uses one continuous narration, not per-scene clips.
  const rawVoice=join(dir,'one-take.wav');
  await cmd(CFG.ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi',
    '-i','sine=frequency=400:sample_rate=44100:duration=8.3','-ac','1','-c:a','pcm_s16le',rawVoice]);
  const audio=await assembleNarration(dir,script,[rawVoice],info.duration);
  const videoOut=await renderVideo(dir,video,audio,script,{watermark:'CLIPCRAFT TEST',opacity:35,captions:true,cta:true,originalAudio:false,fit:'fill'},info);
  const out=await probe(videoOut);
  const bytes=(await stat(videoOut)).size;
  if(!(out.hasAudio && out.width===720 && out.height===1280 && bytes>30000)) throw new Error(`Unexpected render ${JSON.stringify(out)}, ${bytes} bytes`);
  console.log(`PASS: FFmpeg rendered ${out.duration.toFixed(1)}s 720x1280 MP4 with AAC, ASS captions, watermark and CTA (${Math.round(bytes/1024)}KB)`);
} finally {await rm(dir,{recursive:true,force:true});}
