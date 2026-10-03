import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { CFG } from './env.mjs';
import { audioFitPlan } from './audio-fit.mjs';
import { cmd, probe, renderVideo, assembleNarration, durationOf, writeMetadata } from './media.mjs';
import { analyzeVideo, generateScriptFromContext, cartesiaVoices, speakCartesia, validateScript, retimeScriptForVoice, GEMINI_MODELS } from './ai.mjs';

const workBase = resolve(process.cwd(), 'work');
const workRoot = join(workBase, 'jobs');
if (CFG.purgeWorkOnStart) await rm(workBase, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });
const jobs = new Map();
const MAX_ACTIVE = 2;
const hasKeys = () => Boolean(CFG.geminiKey && CFG.cartesiaKey);
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const message = e => String(e?.message || e || 'Unknown error').replace(/sk_car_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]').slice(0, 1200);

function cors(req, res) {
  const origin = req.headers.origin;
  // local-only app; explicitly scoped CORS rather than reflecting arbitrary web origins
  if (!origin || CFG.origin.split(',').map(x=>x.trim()).includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Options');
  }
}
function cleanOptions(o = {}) {
  const language = o.language === 'hi' ? 'hi' : 'en';
  const defaultVoice = language === 'hi' ? CFG.cartesiaHindiVoice : CFG.cartesiaVoice;
  return {
    language,
    geminiModel: GEMINI_MODELS.includes(o.geminiModel) ? o.geminiModel : CFG.geminiModel,
    tone: ['funny','curious','wholesome'].includes(o.tone) ? o.tone : 'funny',
    watermark: String(o.watermark ?? '').replace(/[\r\n]/g, ' ').slice(0, 35),
    opacity: Math.min(100, Math.max(0, Number(o.opacity ?? 42) || 0)),
    captions: o.captions !== false,
    coverOriginalCaptions: o.coverOriginalCaptions === true,
    cta: o.cta !== false,
    originalAudio: o.originalAudio === true,
    fit: o.fit === 'contain' ? 'contain' : 'fill',
    voiceId: /^[a-zA-Z0-9_-]{1,80}$/.test(String(o.voiceId || '')) ? String(o.voiceId) : defaultVoice,
    review: o.review === true
  };
}
function externalJob(j) {
  return {
    id: j.id, status: j.status, step: j.step, percent: j.percent, error: j.error || null,
    scriptRevision: j.scriptRevision || 0, hasAnalysis: !!j.context,
    info: j.info || null, script: j.script || null, options: j.options,
    videoUrl: j.status === 'done' ? `/api/jobs/${j.id}/file/video` : null,
    captionsUrl: j.status === 'done' ? `/api/jobs/${j.id}/file/captions` : null,
    metadataUrl: j.status === 'done' ? `/api/jobs/${j.id}/file/metadata` : null,
    createdAt: j.createdAt
  };
}
function progress(j, step, percent, status) { j.step = step; j.percent = percent; if (status) j.status = status; }
async function inputToMp4(j, filePath, mimetype) {
  if (mimetype === 'video/mp4') return filePath;
  progress(j, 'Converting your video to MP4 for Gemini…', 9);
  const converted = join(j.dir, 'normalized.mp4');
  await cmd(CFG.ffmpeg, ['-hide_banner','-loglevel','error','-y','-i',filePath,'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','24','-c:a','aac','-movflags','+faststart',converted], { timeoutMs: 300000 });
  return converted;
}
async function renderJob(j) {
  try {
    progress(j, 'Cartesia is generating one continuous voiceover…', 52, 'rendering');
    const originalScript = structuredClone(j.script);
    let chosenScript = originalScript;
    let bestVoice = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let autoPolished = false;
    // Real TTS output is the ground truth; script word counts are only hints.
    // Max one automatic Gemini rewrite + a second TTS call to bound quota use.
    for (let take = 0; take < 2; take++) {
      const voiceFile = join(j.dir, `cartesia-take-${take + 1}.wav`);
      const fullText = chosenScript.beats.map(b => b.text.trim()).filter(Boolean).join(' ');
      if (!fullText) throw new Error('AI generated an empty narration');
      try {
        await speakCartesia(fullText, j.options.language, j.options.voiceId, voiceFile);
      } catch (error) {
        if (bestVoice) {
          console.warn(`[job ${j.id}] second voice unavailable; using the valid first take: ${message(error)}`);
          break;
        }
        throw error;
      }
      const seconds = await durationOf(voiceFile);
      const fit = audioFitPlan(seconds, j.info.duration);
      const distance = Math.abs(Math.log(fit.ratio));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestVoice = voiceFile;
        j.script = chosenScript;
      }
      if (!fit.needsRewrite) break;
      if (take === 1 || !j.context) break;
      progress(j, `Voice ${seconds.toFixed(1)}s / video ${j.info.duration.toFixed(1)}s — correcting automatically…`, 74);
      try {
        const polished = await retimeScriptForVoice(
          j.context, chosenScript, j.info.duration, seconds, j.options,
          (step, percentage) => progress(j, step, percentage, 'rendering')
        );
        if (!polished) break;
        chosenScript = polished;
        autoPolished = true;
      } catch (error) {
        // If Gemini quota is exhausted, KEEP the valid initial recording and
        // still export gracefully. No manual action is required for a minor gap.
        console.warn(`[job ${j.id}] optional auto-polish unavailable: ${message(error)}`);
        break;
      }
    }
    if (!bestVoice) throw new Error('Cartesia did not produce a usable voiceover');
    progress(j, 'Balancing narration speed and subtitles with real audio…', 80);
    const voice = await assembleNarration(j.dir, j.script, [bestVoice], j.info.duration);
    const fitInfo = audioFitPlan(await durationOf(bestVoice), j.info.duration);
    if (autoPolished) {
      j.scriptRevision = (j.scriptRevision || 1) + 1;
      j.scriptHistory = [...(j.scriptHistory || []), structuredClone(j.script)].slice(-8);
    }
    await writeMetadata(j.dir, j.script);
    progress(j, 'Rendering captions, watermark and overlays…', 87);
    await renderVideo(j.dir, j.inputPath, voice, j.script, j.options, j.info);
    const note = fitInfo.remainingSeconds > 2.2
      ? ` Voice ends ${fitInfo.remainingSeconds.toFixed(1)}s before the clip; add more narration using Regenerate if you prefer.`
      : '';
    j.completedAt = Date.now();
    progress(j, `Video ready.${note} Temporary files auto-delete in ${Math.round(CFG.outputTtl / 60000)} minutes.`, 100, 'done');
    j.error = null;
  } catch (e) {
    progress(j, 'Rendering failed.', j.percent, 'error');
    j.error = message(e);
    console.error(`[job ${j.id}]`, j.error);
  }
}
async function analyzeJob(j) {
  try {
    progress(j, 'Validating and reading the video…', 7, 'analyzing');
    j.inputPath = await inputToMp4(j, j.originalPath, j.mime);
    j.info = await probe(j.inputPath);
    progress(j, 'Uploading to Google Gemini Files API…', 12);
    const first = await analyzeVideo(j.inputPath, j.info.duration, j.options, (step, percent) => progress(j, step, percent));
    j.script = first.script;
    j.context = first.context;
    j.scriptHistory = [structuredClone(first.script)];
    j.scriptRevision = 1;
    await writeMetadata(j.dir, j.script);
    if (j.options.review) progress(j, 'Script ready. Review or edit it before rendering.', 50, 'review');
    else await renderJob(j);
  } catch (e) { progress(j, 'Video analysis failed.', j.percent, 'error'); j.error = message(e); console.error(`[job ${j.id}]`, j.error); }
}

// Script refresh is separate from rendering and reuses cached visual evidence.
async function regenerateJob(j, options) {
  const oldStatus = j.previousStatus || 'review';
  try {
    const regenerated = await generateScriptFromContext(
      j.context, j.info.duration, options,
      j.scriptHistory || [], (step, percent) => progress(j, step, percent, 'regenerating')
    );
    j.options = options;
    j.script = regenerated;
    j.scriptHistory = [...(j.scriptHistory || []), structuredClone(regenerated)].slice(-8);
    j.scriptRevision = (j.scriptRevision || 1) + 1;
    await writeMetadata(j.dir, j.script);
    j.error = null;
    progress(j, 'A different script is ready. Review and render when happy.', 50, 'review');
  } catch (err) {
    j.error = message(err);
    progress(j, 'New script failed; your old script is unchanged.', 50, oldStatus === 'done' ? 'done' : 'review');
    console.error(`[job ${j.id}] regenerate:`, j.error);
  } finally {
    delete j.previousStatus;
  }
}

async function receiveUpload(req, path) {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > CFG.maxVideoBytes) { const e = new Error('Video exceeds upload size limit'); e.code = 413; throw e; }
  let size = 0;
  const guard = new Transform({ transform(chunk, _, callback) {
    size += chunk.length;
    if (size > CFG.maxVideoBytes) callback(Object.assign(new Error('Video too large'), { code: 413 }));
    else callback(null, chunk);
  }});
  await pipeline(req, guard, createWriteStream(path, { flags: 'wx' }));
  if (size < 2000) throw new Error('Video file is empty or too small');
}
async function readJson(req, max=250000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('JSON request is too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function deliverFile(res, j, kind) {
  const files = { video: ['final.mp4','video/mp4'], captions: ['captions.srt','text/plain; charset=utf-8'], metadata: ['metadata.txt','text/plain; charset=utf-8'], script: ['script.json','application/json'] };
  if (!files[kind]) return json(res, 404, { error: 'Unknown file type' });
  const [name, type] = files[kind], path = join(j.dir, name);
  const s = await stat(path);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': s.size, 'Content-Disposition': `attachment; filename="clipcraft-${kind}.${name.split('.').at(-1)}"`, 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
  createReadStream(path).pipe(res);
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && path === '/api/health') {
      const ffmpeg = await cmd(CFG.ffmpeg, ['-version'], { timeoutMs: 5000 }).then(()=>true,()=>false);
      return json(res, 200, { ok: true, ffmpeg, geminiConfigured: !!CFG.geminiKey, geminiModel: CFG.geminiModel, geminiModels: GEMINI_MODELS, cartesiaConfigured: !!CFG.cartesiaKey, defaultVoice: CFG.cartesiaVoice, hindiVoice: CFG.cartesiaHindiVoice, maxDuration: CFG.maxDuration, maxUploadMB: CFG.maxVideoBytes/1048576 });
    }
    if (req.method === 'GET' && path === '/api/voices') return json(res, 200, { voices: await cartesiaVoices() });
    if (req.method === 'POST' && path === '/api/jobs') {
      if (!hasKeys()) return json(res, 400, { error: 'Set GEMINI_API_KEY and CARTESIA_API_KEY in backend/.env before generating.' });
      const active = [...jobs.values()].filter(x => ['uploading','analyzing','regenerating','rendering'].includes(x.status)).length;
      if (active >= MAX_ACTIVE) return json(res, 429, { error: 'Two videos are processing. Please wait.' });
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!['video/mp4','video/webm','video/quicktime','video/x-matroska'].includes(mime)) return json(res, 415, { error: 'Upload MP4, MOV, WebM or MKV' });
      let opt;
      try { opt = cleanOptions(JSON.parse(Buffer.from(String(req.headers['x-options']||''), 'base64url').toString('utf8'))); }
      catch { return json(res,400,{error:'Invalid upload settings'}); }
      const id = randomUUID(), dir = join(workRoot, id);
      const j = { id, dir, mime, originalPath: join(dir,'source-upload'), options:opt, status:'uploading', step:'Uploading…', percent:2, createdAt:Date.now(), error:null };
      jobs.set(id,j);
      await mkdir(dir,{recursive:true});
      try { await receiveUpload(req,j.originalPath); }
      catch(e) { jobs.delete(id); await rm(dir,{recursive:true,force:true}); throw e; }
      progress(j,'Queued for video analysis',5);
      json(res,202,externalJob(j));
      // Job proceeds after API returns so browser can poll progress.
      void analyzeJob(j);
      return;
    }
    const m = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(render|regenerate|file)(?:\/(video|captions|metadata|script))?)?$/.exec(path);
    if (m) {
      const j = jobs.get(m[1]);
      if (!j) return json(res,404,{error:'Job not found, possibly expired'});
      if (req.method === 'GET' && !m[2]) return json(res,200,externalJob(j));
      if (req.method === 'GET' && m[2] === 'file' && m[3]) {
        if (!['done','review'].includes(j.status)) return json(res,409,{error:'File not ready'});
        if (j.status === 'review' && !['script','metadata'].includes(m[3])) return json(res,409,{error:'Video not rendered yet'});
        return await deliverFile(res,j,m[3]);
      }
      if (req.method === 'POST' && m[2] === 'regenerate') {
        if (!['review','done','error'].includes(j.status) || !j.context || !j.info) {
          return json(res,409,{error:'First analyze a video and wait for the script to finish.'});
        }
        const active = [...jobs.values()].filter(x => ['analyzing','regenerating','rendering'].includes(x.status)).length;
        if (active >= MAX_ACTIVE) return json(res,429,{error:'Server is currently processing two jobs.'});
        const posted = await readJson(req);
        const options = cleanOptions({...j.options,...(posted.options || {})});
        if (!GEMINI_MODELS.includes(options.geminiModel)) return json(res,400,{error:'Invalid model'});
        j.previousStatus = j.status;
        j.error = null;
        progress(j,'Regenerating a new script using saved video analysis…',35,'regenerating');
        json(res,202,externalJob(j));
        void regenerateJob(j,options);
        return;
      }
      if (req.method === 'POST' && m[2] === 'render') {
        if (!['review','error','done'].includes(j.status) || !j.script || !j.info) return json(res,409,{error:'Analyze the video before rendering'});
        const posted = await readJson(req);
        const mergedOptions = cleanOptions({ ...j.options, ...(posted.options || {}) });
        if (mergedOptions.language !== j.script.language) return json(res,409,{error:'Language changed. Press Regenerate Script to rewrite in the selected language first.'});
        j.script = validateScript(posted.script || j.script, j.info.duration, mergedOptions.language);
        j.options = mergedOptions;
        j.error = null;
        progress(j,'Queued for final video render',51,'rendering');
        json(res,202,externalJob(j));
        void renderJob(j);
        return;
      }
    }
    json(res,404,{error:'Not found'});
  } catch(e) { if (!res.headersSent) json(res,e.code === 413 ? 413 : 400,{error:message(e)}); else res.destroy(); }
});
const cleaner = setInterval(async () => {
  for (const [id, j] of jobs) {
    const active = ['uploading','analyzing','regenerating','rendering'].includes(j.status);
    const limit = j.status === 'done' ? CFG.outputTtl : CFG.ttl;
    const since = j.status === 'done' ? (j.completedAt || j.createdAt) : j.createdAt;
    if (!active && Date.now() - since > limit) {
      jobs.delete(id); await rm(j.dir,{recursive:true,force:true}).catch(()=>{});
    }
  }
}, 30000);
cleaner.unref();
server.listen(CFG.port,()=>console.log(`ClipCraft API ready: http://localhost:${CFG.port} • ${hasKeys()?'keys configured':'configure API keys in .env'}`));
