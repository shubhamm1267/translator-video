import { spawn } from 'node:child_process';
import { access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CFG } from './env.mjs';
import { audioFitPlan } from './audio-fit.mjs';

export async function cmd(executable, args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${executable} timed out`)); }, timeoutMs);
    p.stdout.on('data', d => stdout = (stdout + d.toString()).slice(-150000));
    p.stderr.on('data', d => stderr = (stderr + d.toString()).slice(-12000));
    p.on('error', e => { clearTimeout(t); reject(new Error(`${executable} missing or unavailable: ${e.message}`)); });
    p.on('close', code => { clearTimeout(t); if (code !== 0) reject(new Error(`${executable} failed: ${stderr.slice(-2200)}`)); else resolve({ stdout, stderr }); });
  });
}

export async function probe(path) {
  const { stdout } = await cmd(CFG.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { timeoutMs: 15000 });
  const data = JSON.parse(stdout);
  const v = data.streams?.find(s => s.codec_type === 'video');
  if (!v) throw new Error('No video track detected');
  const duration = Number(data.format?.duration || v.duration);
  if (!Number.isFinite(duration) || duration < 3 || duration > CFG.maxDuration) throw new Error(`Choose a video between 3 and ${CFG.maxDuration} seconds (received ${duration || '?'}s)`);
  return { duration, width: Number(v.width), height: Number(v.height), hasAudio: data.streams.some(s => s.codec_type === 'audio'), codec: v.codec_name };
}
export async function durationOf(path) {
  const { stdout } = await cmd(CFG.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('Cannot read voice duration');
  return d;
}

export function escapeAss(str) {
  return String(str || '').replace(/[\\{}]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
function stamp(s) {
  const time = Math.max(0, Number(s));
  const cs = Math.round(time * 100);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, ss = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function srtStamp(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
}
export function captionSegments(script, speechSeconds) {
  // Continuous narration gets proportional captions across the entire video.
  // Do not stretch each short sentence to fill an artificial beat window.
  const text = (script.beats || []).map(b => b.text).join(' ').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks = captionChunks(words, script.language);
  const total = chunks.reduce((n, c) => n + Math.max(1, c.length), 0);
  const fullDuration = Number(script.beats.at(-1)?.end || 0);
  const duration = speechSeconds === undefined ? fullDuration : Math.min(fullDuration, Math.max(0, Number(speechSeconds) || 0));
  let done = 0;
  return chunks.map(c => {
    const a = duration * done / total;
    done += Math.max(1, c.length);
    const b = duration * done / total;
    return { start: Number(a.toFixed(3)), end: Number(b.toFixed(3)), text: c };
  }).filter(c => c.end > c.start);
}

function captionChunks(words, language) {
  // Keep captions inside a conservative mobile safe area. A fixed 4-word
  // chunk can overflow badly with wide English words like "everyone turns".
  const maxChars = language === 'hi' ? 16 : 18;
  const maxWords = language === 'hi' ? 3 : 3;
  const chunks = [];
  let current = [];
  for (const raw of words) {
    const word = String(raw || '').trim();
    if (!word) continue;
    const next = [...current, word];
    const tooWide = next.join(' ').length > maxChars;
    const tooMany = next.length > maxWords;
    if (current.length && (tooWide || tooMany)) {
      chunks.push(current.join(' '));
      current = [word];
    } else {
      current = next;
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

export async function overlayFiles(dir, script, opts, duration, speechSeconds = duration) {
  const watermarkText = escapeAss(opts.watermark || '').slice(0, 34);
  const opacity = Math.max(0, Math.min(100, Number(opts.opacity ?? 42)));
  const assOpacity = Math.round(255 * (1 - opacity / 100)).toString(16).padStart(2, '0').toUpperCase();
  const ctaStart = Math.max(1, duration - 4.6);
  const font = script.language === 'hi' ? 'Noto Sans Devanagari' : 'DejaVu Sans';
  const head = `[Script Info]\nTitle: ClipCraft Pro Overlays\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Caption,${font},50,&H00FFFFFF,&H0000E9FF,&H00141A23,&H65000000,-1,0,0,0,100,100,0,0,1,4,2,2,72,72,260,1\nStyle: Watermark,DejaVu Sans,24,&H00FFFFFF,&H00FFFFFF,&H000A1520,&H90000000,-1,0,0,0,100,100,0,0,1,1,1,9,20,28,36,1\nStyle: CTA,DejaVu Sans,39,&H00FFFFFF,&H0000FFFF,&H0020314A,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,30,30,100,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  let events = '';
  if (watermarkText && opacity > 0) {
    events += `Dialogue: 10,0:00:00.00,${stamp(duration)},Watermark,,0,0,0,,{\\alpha&H${assOpacity}&\\fad(160,200)}${watermarkText}\n`;
  }
  const captions = opts.captions === false ? [] : captionSegments(script, speechSeconds);
  for (const c of captions) {
    const label = escapeAss(c.text);
    events += `Dialogue: 5,${stamp(c.start)},${stamp(c.end)},Caption,,0,0,0,,{\\q2\\fad(70,90)\\t(0,135,\\fscx104\\fscy104)\\t(135,320,\\fscx100\\fscy100)}${label}\n`;
  }
  if (opts.cta !== false && duration > 7) {
    const bits = [
      { a: ctaStart, b: ctaStart + 1.35, text: '▶  SUBSCRIBE', col: '&H002B6BFF&' },
      { a: ctaStart + 1.4, b: ctaStart + 3.0, text: '♥  LIKE', col: '&H00FFF0FF&' },
      { a: ctaStart + 3.05, b: Math.min(duration, ctaStart + 4.4), text: '🔔  BELL ON', col: '&H0000F7FF&' }
    ];
    for (const b of bits) {
      events += `Dialogue: 12,${stamp(b.a)},${stamp(b.b)},CTA,,0,0,0,,{\\c${b.col}\\move(360,1390,360,1135,0,280)\\t(100,250,\\fscx112\\fscy112)\\t(260,390,\\fscx100\\fscy100)\\fad(70,130)}${b.text}\n`;
    }
  }
  const ass = join(dir, 'overlays.ass');
  await writeFile(ass, head + events, 'utf8');
  let srt = '', i = 0;
  for (const c of captions) {
    srt += `${++i}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n\n`;
  }
  await writeFile(join(dir, 'captions.srt'), srt, 'utf8');
  return { ass, captions: captions.length };
}

export async function assembleNarration(dir, script, rawPaths, duration) {
  if (!rawPaths.length) throw new Error('Cartesia voice WAV is missing');
  if (rawPaths.length !== 1) throw new Error('Expected one continuous voice take');
  const original = await durationOf(rawPaths[0]);
  const plan = audioFitPlan(original, duration);
  const narration = join(dir, 'narration.wav');
  const fadeStart = Math.max(0, Math.min(duration - 0.16, plan.speechEnd - 0.16));
  const chain = [
    `atempo=${plan.tempo.toFixed(5)}`,
    'aresample=48000',
    'aformat=channel_layouts=mono',
    `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.14`,
    'apad',
    `atrim=duration=${duration.toFixed(4)}`
  ].join(',');
  await cmd(CFG.ffmpeg, ['-hide_banner','-loglevel','error','-y',
    '-i',rawPaths[0],'-af',chain,'-ac','1','-ar','48000','-c:a','pcm_s16le',narration],
    {timeoutMs:120000});
  // Timed captions should stop where the actual speech stops, not spread
  // to the end of a silent padded clip.
  await writeFile(join(dir,'narration-timing.json'), JSON.stringify({
    rawSeconds:original, speechSeconds:plan.speechEnd,
    videoSeconds:duration, tempo:plan.tempo,
    remainingSeconds:plan.remainingSeconds
  },null,2));
  return narration;
}

export async function renderVideo(dir, inputPath, voicePath, script, opts, info) {
  const { duration } = info;
  let speechSeconds = duration;
  try {
    const timing = JSON.parse(await readFile(join(dir,'narration-timing.json'),'utf8'));
    if (Number.isFinite(timing.speechSeconds)) speechSeconds = Math.max(0, Math.min(duration, timing.speechSeconds));
  } catch {}
  await overlayFiles(dir, script, opts, duration, speechSeconds);
  const args = ['-hide_banner','-loglevel','error','-y','-i',inputPath,'-i',voicePath];
  const musicPath = join(process.cwd(), 'assets', 'background.mp3');
  const customMusic = await access(musicPath).then(() => musicPath, () => '');
  const renderMusic = customMusic || await createEnergeticMusicBed(dir, duration);
  const hasMusic = Boolean(renderMusic);
  if (hasMusic && customMusic) args.push('-stream_loop','-1','-i',renderMusic);
  else if (hasMusic) args.push('-i', renderMusic);
  const fill = opts.fit === 'contain'
    ? 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x10131C'
    : 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280';
  // Optional masking for videos that have captions permanently burned in.
  // This is NOT reconstruction: the small image region behind text is obscured.
  const cover = opts.coverOriginalCaptions === true
    ? ',drawbox=x=0:y=875:w=iw:h=190:color=0x151A22@0.90:t=fill'
    : '';
  const voiceFx = 'aresample=48000,acompressor=threshold=0.08:ratio=2.5:attack=5:release=80,equalizer=f=3500:t=q:w=1.2:g=2.5,volume=1.18';
  let filter = `[0:v]fps=30,${fill},setsar=1${cover},ass=overlays.ass,format=yuv420p[v];[1:a]${voiceFx}${hasMusic ? ',asplit=2[nmix][nside]' : '[nar]'};`;
  const audios = [hasMusic ? '[nmix]' : '[nar]'];
  if (opts.originalAudio === true && info.hasAudio) {
    filter += `[0:a]aresample=48000,volume=0.07,apad,atrim=duration=${duration.toFixed(4)}[amb];`;
    audios.push('[amb]');
  }
  if (hasMusic) {
    filter += `[2:a]aresample=48000,volume=0.28,atrim=duration=${duration.toFixed(4)}[music];`;
    filter += '[music][nside]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=280[duck];';
    audios.push('[duck]');
  }
  filter += audios.join('') + `amix=inputs=${audios.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.2:LRA=8,alimiter=limit=0.94,apad,atrim=duration=${duration.toFixed(4)}[a]`;
  const output = join(dir, 'final.mp4');
  args.push('-filter_complex',filter,'-map','[v]','-map','[a]',
    '-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p',
    '-r','30','-c:a','aac','-b:a','192k','-movflags','+faststart',
    '-t',String(duration),output);
  await cmd(CFG.ffmpeg, args, { cwd:dir, timeoutMs:600000 });
  await access(output);
  return output;
}

async function createEnergeticMusicBed(dir, duration) {
  const bed = join(dir, 'energetic-bed.wav');
  const seconds = Math.max(3, Number(duration) || 3);
  const expression = [
    '0.10*sin(2*PI*55*t)*if(lt(mod(t\\,0.5)\\,0.10)\\,exp(-mod(t\\,0.5)*22)\\,0)',
    '0.035*sin(2*PI*880*t)*if(lt(mod(t+0.125\\,0.25)\\,0.035)\\,exp(-mod(t+0.125\\,0.25)*70)\\,0)'
  ].join('+');
  try {
    await cmd(CFG.ffmpeg, ['-hide_banner','-loglevel','error','-y',
      '-f','lavfi','-i',`aevalsrc=${expression}:s=48000:d=${seconds.toFixed(4)}`,
      '-af','alimiter=limit=0.70','-ac','1','-ar','48000','-c:a','pcm_s16le',bed],
      { timeoutMs: 35000 });
    await access(bed);
    return bed;
  } catch {
    return '';
  }
}

export async function writeMetadata(dir, script) {
  const m = script.metadata;
  const sources = Array.isArray(m.sources) ? m.sources.map(x => `${x.title}: ${x.url}`).join('\n') : '';
  const txt = `${m.title}\n\nDESCRIPTION\n${m.description}\n\nTAGS\n${m.tags.join(', ')}\n\nNARRATION\n${script.beats.map(b=>`[${b.start.toFixed(1)}s–${b.end.toFixed(1)}s] ${b.text}`).join('\n')}\n\nOPTIONAL RESEARCH LEADS (verify before publishing)\n${sources || 'No external facts fetched'}\n`;
  await writeFile(join(dir, 'metadata.txt'), txt);
  await writeFile(join(dir, 'script.json'), JSON.stringify(script, null, 2));
}
