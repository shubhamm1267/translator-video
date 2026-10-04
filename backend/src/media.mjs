
import { spawn } from 'node:child_process';

import {
  access,
  writeFile,
  readFile
} from 'node:fs/promises';

import { join } from 'node:path';
import { CFG } from './env.mjs';
import { audioFitPlan } from './audio-fit.mjs';

// ====================================
// COMMAND RUNNER
// ====================================

export async function cmd(
  exe,
  args,
  {
    cwd,
    timeoutMs = 180000
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      err ? reject(err) : resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');

      finish(
        new Error(`${exe} timed out`)
      );
    }, timeoutMs);

    child.stdout.on('data', b => {
      stdout = (
        stdout + b.toString()
      ).slice(-150000);
    });

    child.stderr.on('data', b => {
      stderr = (
        stderr + b.toString()
      ).slice(-12000);
    });

    child.on('error', e => {
      finish(
        new Error(
          `${exe} unavailable: ${e.message}`
        )
      );
    });

    child.on('close', code => {
      code === 0
        ? finish(null, { stdout, stderr })
        : finish(
            new Error(
              `${exe} failed: ${stderr.slice(-2200)}`
            )
          );
    });
  });
}

// ====================================
// VIDEO INFORMATION
// ====================================

export async function probe(file) {
  const { stdout } = await cmd(
    CFG.ffprobe,
    [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      file
    ],
    {
      timeoutMs: 15000
    }
  );

  const data = JSON.parse(stdout);
  const tracks = data.streams || [];

  const video = tracks.find(
    x => x.codec_type === 'video'
  );

  if (!video) {
    throw new Error('No video track');
  }

  const duration = Number(
    data.format?.duration ||
    video.duration
  );

  if (
    !Number.isFinite(duration) ||
    duration < 3 ||
    duration > CFG.maxDuration
  ) {
    throw new Error(
      `Choose 3-${CFG.maxDuration}s video ` +
      `(received ${duration || '?'}s)`
    );
  }

  return {
    duration,
    width: Number(video.width),
    height: Number(video.height),
    hasAudio: tracks.some(
      x => x.codec_type === 'audio'
    ),
    codec: video.codec_name
  };
}

// ====================================
// ACTUAL VOICE DURATION
// ====================================

export async function durationOf(file) {
  const { stdout } = await cmd(
    CFG.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file
    ]
  );

  const full = Number(stdout.trim());

  if (!Number.isFinite(full) || full <= 0) {
    throw new Error(
      'Cannot read audio duration'
    );
  }

  // Detect trailing silence added by TTS.
  try {
    const { stderr } = await cmd(
      CFG.ffmpeg,
      [
        '-hide_banner',
        '-i',
        file,
        '-af',
        'silencedetect=noise=-43dB:d=0.38',
        '-f',
        'null',
        '-'
      ],
      {
        timeoutMs: 90000
      }
    );

    const starts = [
      ...stderr.matchAll(
        /silence_start:\s*([0-9.]+)/g
      )
    ].map(x => +x[1]);

    const ends = [
      ...stderr.matchAll(
        /silence_end:\s*([0-9.]+)/g
      )
    ].map(x => +x[1]);

    const start = starts.at(-1);
    const end = ends.at(-1);

    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= full - 0.2 &&
      start > 0.4 &&
      full - start > 0.45
    ) {
      return Math.min(
        full,
        start + 0.08
      );
    }
  } catch {
    // Use full duration if silence detection fails.
  }

  return full;
}

// ====================================
// CAPTION HELPERS
// ====================================

export function escapeAss(text) {
  return String(text || '')
    .replace(/[\\{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function stamp(seconds) {
  const cs = Math.max(
    0,
    Math.round(seconds * 100)
  );

  return (
    `${Math.floor(cs / 360000)}:` +
    `${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:` +
    `${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.` +
    `${String(cs % 100).padStart(2, '0')}`
  );
}

function srtStamp(seconds) {
  const ms = Math.max(
    0,
    Math.round(seconds * 1000)
  );

  return (
    `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:` +
    `${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:` +
    `${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},` +
    `${String(ms % 1000).padStart(3, '0')}`
  );
}

function chunkWords(words, lang) {
  const chars = lang === 'hi' ? 16 : 18;

  const result = [];
  const current = [];

  for (const word of words) {
    if (
      current.length &&
      (
        current.length >= 3 ||
        [...current, word].join(' ').length > chars
      )
    ) {
      result.push(current.join(' '));
      current.length = 0;
    }

    current.push(word);
  }

  if (current.length) {
    result.push(current.join(' '));
  }

  return result;
}

export function captionSegments(
  script,
  speechSeconds
) {
  const words = (script.beats || [])
    .map(b => b.text)
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return [];

  const chunks = chunkWords(
    words,
    script.language
  );

  const total = chunks.reduce(
    (x, text) =>
      x + Math.max(1, text.length),
    0
  );

  const full = Number(
    script.beats.at(-1)?.end || 0
  );

  const duration = speechSeconds === undefined
    ? full
    : Math.min(
        full,
        Math.max(0, Number(speechSeconds) || 0)
      );

  let used = 0;

  return chunks
    .map(text => {
      const start =
        duration * used / total;

      used += Math.max(
        1,
        text.length
      );

      const end =
        duration * used / total;

      return {
        start: +start.toFixed(3),
        end: +end.toFixed(3),
        text
      };
    })
    .filter(x => x.end > x.start);
}

// ====================================
// OVERLAYS / CAPTIONS / CTA
// ====================================

export async function overlayFiles(
  dir,
  script,
  opts,
  duration,
  speechSeconds = duration
) {
  const font = script.language === 'hi'
    ? CFG.captionFontHi
    : CFG.captionFontEn;

  const opacity = Math.max(
    0,
    Math.min(
      100,
      Number(opts.opacity ?? 42)
    )
  );

  const hexAlpha = Math.round(
    255 * (1 - opacity / 100)
  )
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

  const mark = escapeAss(
    opts.watermark || ''
  ).slice(0, 34);

  const head = `[Script Info]
Title: ClipCraft Pro
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,${font},50,&H00FFFFFF,&H0000E9FF,&H00141A23,&H65000000,-1,0,0,0,100,100,0,0,1,4,2,2,72,72,260,1
Style: Watermark,DejaVu Sans,24,&H00FFFFFF,&H00FFFFFF,&H000A1520,&H90000000,-1,0,0,0,100,100,0,0,1,1,1,9,20,28,36,1
Style: CTA,DejaVu Sans,39,&H00FFFFFF,&H0000FFFF,&H0020314A,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,30,30,100,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  let events = '';

  // WATERMARK
  if (mark && opacity > 0) {
    events +=
      `Dialogue: 10,0:00:00.00,${stamp(duration)},Watermark,,0,0,0,,` +
      `{\\alpha&H${hexAlpha}&\\fad(160,200)}${mark}\n`;
  }

  // VOICE CAPTIONS
  const captions = opts.captions === false
    ? []
    : captionSegments(
        script,
        speechSeconds
      );

  for (const c of captions) {
    events +=
      `Dialogue: 5,${stamp(c.start)},${stamp(c.end)},Caption,,0,0,0,,` +
      `{\\q2\\fad(70,90)\\t(0,135,\\fscx104\\fscy104)` +
      `\\t(135,320,\\fscx100\\fscy100)}` +
      `${escapeAss(c.text)}\n`;
  }

  // LIKE / SUBSCRIBE / BELL
  if (
    opts.cta !== false &&
    duration > 7
  ) {
    const first = Math.max(
      1,
      duration - 4.6
    );

    const animations = [
      {
        a: first,
        z: first + 1.05,
        t: 'SUBSCRIBE',
        c: '&H002B6BFF&'
      },
      {
        a: first + 1.28,
        z: first + 2.35,
        t: 'LIKE',
        c: '&H00FFF0FF&'
      },
      {
        a: first + 2.62,
        z: Math.min(
          duration,
          first + 3.82
        ),
        t: 'BELL ON',
        c: '&H0000F7FF&'
      }
    ];

    for (const b of animations) {
      events +=
        `Dialogue: 12,${stamp(b.a)},${stamp(b.z)},CTA,,0,0,0,,` +
        `{\\c${b.c}\\pos(360,1135)` +
        `\\fscx88\\fscy88` +
        `\\t(0,170,\\fscx116\\fscy116)` +
        `\\t(170,340,\\fscx100\\fscy100)` +
        `\\fad(80,140)}${b.t}\n`;
    }
  }

  const ass = join(
    dir,
    'overlays.ass'
  );

  await writeFile(
    ass,
    head + events,
    'utf8'
  );

  let srt = '';

  captions.forEach((c, i) => {
    srt +=
      `${i + 1}\n` +
      `${srtStamp(c.start)} --> ${srtStamp(c.end)}\n` +
      `${c.text}\n\n`;
  });

  await writeFile(
    join(dir, 'captions.srt'),
    srt,
    'utf8'
  );

  return {
    ass,
    captions: captions.length
  };
}

// ====================================
// CONTINUOUS NARRATION
// ====================================

export async function assembleNarration(
  dir,
  _script,
  rawPaths,
  duration
) {
  if (rawPaths.length !== 1) {
    throw new Error(
      'Expected one continuous Cartesia WAV'
    );
  }

  const original = await durationOf(
    rawPaths[0]
  );

  const output = join(
    dir,
    'narration.wav'
  );

  await cmd(
    CFG.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      rawPaths[0],
      '-af',
      'aresample=48000,aformat=channel_layouts=mono',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      output
    ],
    {
      timeoutMs: 120000
    }
  );

  await writeFile(
    join(dir, 'narration-timing.json'),
    JSON.stringify(
      {
        rawSeconds: original,
        videoSeconds: duration,
        method: 'video-and-audio-timebase'
      },
      null,
      2
    )
  );

  return output;
}

// ====================================
// BACKGROUND MUSIC
// ====================================

// Prefer your own licensed background.mp3.
// Otherwise generate a subtle rhythmic bed.

async function optionalMusic(
  dir,
  duration
) {
  const music = join(
    process.cwd(),
    'assets',
    'background.mp3'
  );

  if (
    await access(music).then(
      () => true,
      () => false
    )
  ) {
    return {
      path: music,
      loop: true
    };
  }

  const generated = join(
    dir,
    'energetic-bed.wav'
  );

  const expression = [
    '0.052*sin(2*PI*58*t)*if(lt(mod(t\\,0.75)\\,0.12)\\,exp(-mod(t\\,0.75)*24)\\,0)',
    '0.018*sin(2*PI*116*t)*if(lt(mod(t+0.18\\,1.5)\\,0.16)\\,exp(-mod(t+0.18\\,1.5)*18)\\,0)'
  ].join('+');

  try {
    await cmd(
      CFG.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${expression}:s=48000:d=${duration.toFixed(4)}`,
        '-af',
        'alimiter=limit=0.70',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s16le',
        generated
      ],
      {
        timeoutMs: 35000
      }
    );

    return {
      path: generated,
      loop: false
    };
  } catch {
    return {
      path: '',
      loop: false
    };
  }
}

// ====================================
// CTA SOUND EFFECTS
// ====================================

async function createCtaSfx(
  dir,
  duration
) {
  const path = join(
    dir,
    'cta-sfx.wav'
  );

  const start = Math.max(
    1,
    duration - 4.6
  );

  const hit = (
    at,
    len,
    freq,
    gain
  ) =>
    `${gain}*sin(2*PI*${freq}*(t-${at.toFixed(3)}))*` +
    `if(between(t\\,${at.toFixed(3)}\\,${(at + len).toFixed(3)})\\,` +
    `exp(-(t-${at.toFixed(3)})*26)\\,0)`;

  const expr = [
    hit(start + 0.18, 0.18, 185, 0.18),
    hit(start + 0.20, 0.11, 420, 0.07),
    hit(start + 1.44, 0.08, 720, 0.10),
    hit(start + 1.53, 0.08, 980, 0.08),
    hit(start + 2.82, 0.42, 1180, 0.10),
    hit(start + 2.84, 0.36, 1580, 0.055)
  ].join('+');

  try {
    await cmd(
      CFG.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${expr}:s=48000:d=${duration.toFixed(4)}`,
        '-af',
        'alimiter=limit=0.48',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s16le',
        path
      ],
      {
        timeoutMs: 35000
      }
    );

    return path;
  } catch {
    return '';
  }
}

// ====================================
// FINAL VIDEO RENDERING
// ====================================

export async function renderVideo(
  dir,
  input,
  voice,
  script,
  opts,
  info
) {
  let voiceSeconds;

  try {
    const timing = JSON.parse(
      await readFile(
        join(dir, 'narration-timing.json'),
        'utf8'
      )
    );

    voiceSeconds = timing.rawSeconds;
  } catch {
    voiceSeconds = await durationOf(voice);
  }

  // This requires the latest audio-fit.mjs
  // that supports canRender / outputSeconds.
  const plan = audioFitPlan(
    voiceSeconds,
    info.duration,
    opts.voiceStyle
  );

  if (!plan.canRender) {
    throw new Error(
      `Narration ${voiceSeconds.toFixed(1)}s cannot fit ` +
      `${info.duration.toFixed(1)}s video without a ` +
      'long silent ending or cut-off. ' +
      'Use Regenerate Script.'
    );
  }

  const duration = plan.outputSeconds;

  await overlayFiles(
    dir,
    script,
    opts,
    duration,
    plan.speechEnd
  );

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-i',
    voice
  ];

  const musicSource = await optionalMusic(
    dir,
    duration
  );

  const music = musicSource.path;

  const sfx =
    opts.cta !== false && duration > 7
      ? await createCtaSfx(dir, duration)
      : '';

  if (music) {
    if (musicSource.loop) {
      args.push(
        '-stream_loop',
        '-1'
      );
    }

    args.push(
      '-i',
      music
    );
  }

  if (sfx) {
    args.push(
      '-i',
      sfx
    );
  }

  const fit = opts.fit === 'contain'
    ? 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x10131C'
    : 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280';

  const cover =
    opts.coverOriginalCaptions === true
      ? ',drawbox=x=0:y=875:w=iw:h=190:color=0x151A22@0.90:t=fill'
      : '';

  const voiceFx =
    'aresample=48000,' +
    `atempo=${plan.tempo.toFixed(5)},` +
    'acompressor=threshold=0.075:ratio=3:attack=4:release=75,' +
    'equalizer=f=3300:t=q:w=1.1:g=3.2,' +
    'volume=1.18,' +
    `atrim=duration=${duration.toFixed(4)},` +
    'apad,' +
    `atrim=duration=${duration.toFixed(4)}`;

  let filter =
    `[0:v]setpts=(PTS-STARTPTS)/${plan.videoRate.toFixed(6)},` +
    `fps=30,${fit},setsar=1${cover},` +
    'ass=overlays.ass,format=yuv420p[v];' +

    `[1:a]${voiceFx}` +

    (
      music
        ? ',asplit=2[nmix][nside]'
        : '[nar]'
    ) +
    ';';

  const streams = [
    music ? '[nmix]' : '[nar]'
  ];

  // Original ambient audio
  if (
    opts.originalAudio === true &&
    info.hasAudio
  ) {
    filter +=
      `[0:a]aresample=48000,` +
      `atempo=${plan.videoRate.toFixed(5)},` +
      'volume=0.07,' +
      `atrim=duration=${duration.toFixed(4)},` +
      'apad,' +
      `atrim=duration=${duration.toFixed(4)}` +
      '[amb];';

    streams.push('[amb]');
  }

  // Background music with narration ducking
  if (music) {
    filter +=
      `[2:a]aresample=48000,` +
      'volume=0.16,' +
      `atrim=duration=${duration.toFixed(4)}` +
      '[music];' +

      '[music][nside]' +
      'sidechaincompress=' +
      'threshold=0.025:' +
      'ratio=8:' +
      'attack=25:' +
      'release=280' +
      '[duck];';

    streams.push('[duck]');
  }

  // Like / Subscribe / Bell sounds
  if (sfx) {
    const idx = music ? 3 : 2;

    filter +=
      `[${idx}:a]aresample=48000,` +
      'volume=0.18,' +
      `atrim=duration=${duration.toFixed(4)}` +
      '[sfx];';

    streams.push('[sfx]');
  }

  // Final audio mix
  filter +=
    streams.join('') +

    `amix=inputs=${streams.length}:duration=first:normalize=0,` +

    'loudnorm=I=-14:TP=-1.0:LRA=7,' +
    'alimiter=limit=0.95,' +
    'apad,' +
    `atrim=duration=${duration.toFixed(4)}` +
    '[a]';

  const output = join(
    dir,
    'final.mp4'
  );

  args.push(
    '-filter_complex',
    filter,

    '-map',
    '[v]',

    '-map',
    '[a]',

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-crf',
    '20',

    '-pix_fmt',
    'yuv420p',

    '-r',
    '30',

    '-c:a',
    'aac',

    '-b:a',
    '192k',

    '-movflags',
    '+faststart',

    '-t',
    duration.toFixed(4),

    output
  );

  await cmd(
    CFG.ffmpeg,
    args,
    {
      cwd: dir,
      timeoutMs: 600000
    }
  );

  await access(output);

  await writeFile(
    join(dir, 'render-timing.json'),
    JSON.stringify(
      {
        sourceSeconds: info.duration,
        voiceSeconds,
        finalSeconds: duration,
        visualSpeed: plan.videoRate,
        voiceTempo: plan.tempo,
        speechSeconds: plan.speechEnd,
        remainingSeconds: plan.remainingSeconds,
        style:
          opts.voiceStyle || 'viral_funny'
      },
      null,
      2
    )
  );

  return output;
}

// ====================================
// YOUTUBE METADATA OUTPUT
// ====================================

export async function writeMetadata(
  dir,
  script
) {
  const m = script.metadata || {};

  const sources = Array.isArray(m.sources)
    ? m.sources
        .map(x =>
          `${x.title}: ${x.url}`
        )
        .join('\n')
    : '';

  const narration = (script.beats || [])
    .map(x =>
      `[${Number(x.start).toFixed(1)}s–${Number(x.end).toFixed(1)}s] ${x.text}`
    )
    .join('\n');

  const text =
    `${m.title || ''}\n\n` +

    `DESCRIPTION\n` +
    `${m.description || ''}\n\n` +

    `TAGS\n` +
    `${(m.tags || []).join(', ')}\n\n` +

    `NARRATION\n` +
    `${narration}\n\n` +

    `OPTIONAL RESEARCH (verify before publishing)\n` +
    `${sources || 'No external sources'}\n`;

  await writeFile(
    join(dir, 'metadata.txt'),
    text
  );

  await writeFile(
    join(dir, 'script.json'),
    JSON.stringify(
      script,
      null,
      2
    )
  );
}
