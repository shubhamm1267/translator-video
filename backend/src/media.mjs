
import { spawn } from 'node:child_process';

import {
  access,
  writeFile,
  readFile
} from 'node:fs/promises';

import { join } from 'node:path';

import { CFG } from './env.mjs';

import {
  audioFitPlan
} from './audio-fit.mjs';

// ========================================
// PROCESS COMMANDS
// ========================================

export async function cmd(
  executable,
  args,
  {
    cwd,
    timeoutMs = 180000
  } = {}
) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      executable,
      args,
      {
        cwd,
        windowsHide: true,
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    let stderr = '';
    let stdout = '';

    const timeout = setTimeout(() => {
      process.kill('SIGKILL');

      reject(
        new Error(`${executable} timed out`)
      );
    }, timeoutMs);

    process.stdout.on('data', data => {
      stdout = (
        stdout + data.toString()
      ).slice(-150000);
    });

    process.stderr.on('data', data => {
      stderr = (
        stderr + data.toString()
      ).slice(-12000);
    });

    process.on('error', error => {
      clearTimeout(timeout);

      reject(
        new Error(
          `${executable} missing or unavailable: ${error.message}`
        )
      );
    });

    process.on('close', code => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(
          new Error(
            `${executable} failed: ${stderr.slice(-2200)}`
          )
        );
      } else {
        resolve({
          stdout,
          stderr
        });
      }
    });
  });
}

// ========================================
// VIDEO INFORMATION
// ========================================

export async function probe(path) {
  const { stdout } = await cmd(
    CFG.ffprobe,
    [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      path
    ],
    {
      timeoutMs: 15000
    }
  );

  const data = JSON.parse(stdout);

  const videoStream =
    data.streams?.find(
      stream => stream.codec_type === 'video'
    );

  if (!videoStream) {
    throw new Error(
      'No video track detected'
    );
  }

  const duration = Number(
    data.format?.duration ||
    videoStream.duration
  );

  if (
    !Number.isFinite(duration) ||
    duration < 3 ||
    duration > CFG.maxDuration
  ) {
    throw new Error(
      `Choose a video between 3 and ${CFG.maxDuration} seconds ` +
      `(received ${duration || '?'}s)`
    );
  }

  return {
    duration,

    width: Number(videoStream.width),
    height: Number(videoStream.height),

    hasAudio: data.streams.some(
      stream =>
        stream.codec_type === 'audio'
    ),

    codec: videoStream.codec_name
  };
}

// ========================================
// REAL VOICE DURATION
// ========================================

export async function durationOf(path) {
  const { stdout } = await cmd(
    CFG.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path
    ]
  );

  const full = Number(
    stdout.trim()
  );

  if (
    !Number.isFinite(full) ||
    full <= 0
  ) {
    throw new Error(
      'Cannot read voice duration'
    );
  }

  // Cartesia can generate silence at the end.
  // Detect that silence instead of counting it
  // as spoken narration.

  try {
    const { stderr } = await cmd(
      CFG.ffmpeg,
      [
        '-hide_banner',
        '-i',
        path,

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
    ].map(
      match => Number(match[1])
    );

    const ends = [
      ...stderr.matchAll(
        /silence_end:\s*([0-9.]+)/g
      )
    ].map(
      match => Number(match[1])
    );

    const tailStart =
      starts.at(-1);

    const tailEnd =
      ends.at(-1);

    if (
      Number.isFinite(tailStart) &&
      Number.isFinite(tailEnd) &&
      tailEnd >= full - 0.20 &&
      tailStart > 0.4 &&
      full - tailStart > 0.45
    ) {
      return Math.min(
        full,
        tailStart + 0.08
      );
    }

  } catch {
    // Optional detection.
    // Fall back to WAV duration.
  }

  return full;
}

// ========================================
// CAPTIONS
// ========================================

export function escapeAss(str) {
  return String(str || '')
    .replace(/[\\{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function stamp(seconds) {
  const time = Math.max(
    0,
    Number(seconds)
  );

  const cs = Math.round(
    time * 100
  );

  const hours =
    Math.floor(cs / 360000);

  const minutes =
    Math.floor(cs / 6000) % 60;

  const secs =
    Math.floor(cs / 100) % 60;

  return (
    `${hours}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')}.` +
    `${String(cs % 100).padStart(2, '0')}`
  );
}

function srtStamp(seconds) {
  const milliseconds = Math.max(
    0,
    Math.round(seconds * 1000)
  );

  const hours =
    Math.floor(milliseconds / 3600000);

  const minutes =
    Math.floor(milliseconds / 60000) % 60;

  const secondsPart =
    Math.floor(milliseconds / 1000) % 60;

  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(secondsPart).padStart(2, '0')},` +
    `${String(milliseconds % 1000).padStart(3, '0')}`
  );
}

function captionChunks(words, language) {
  const maxChars =
    language === 'hi' ? 16 : 18;

  const maxWords = 3;

  const chunks = [];

  let current = [];

  for (const raw of words) {
    const word = String(
      raw || ''
    ).trim();

    if (!word) {
      continue;
    }

    const next = [
      ...current,
      word
    ];

    const tooWide =
      next.join(' ').length > maxChars;

    const tooMany =
      next.length > maxWords;

    if (
      current.length &&
      (tooWide || tooMany)
    ) {
      chunks.push(
        current.join(' ')
      );

      current = [word];

    } else {
      current = next;
    }
  }

  if (current.length) {
    chunks.push(
      current.join(' ')
    );
  }

  return chunks;
}

export function captionSegments(
  script,
  speechSeconds
) {
  const text = (
    script.beats || []
  )
    .map(beat => beat.text)
    .join(' ')
    .trim();

  const words = text
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) {
    return [];
  }

  const chunks = captionChunks(
    words,
    script.language
  );

  const total = chunks.reduce(
    (sum, chunk) =>
      sum + Math.max(1, chunk.length),
    0
  );

  const fullDuration = Number(
    script.beats.at(-1)?.end || 0
  );

  const duration =
    speechSeconds === undefined
      ? fullDuration
      : Math.min(
          fullDuration,
          Math.max(
            0,
            Number(speechSeconds) || 0
          )
        );

  let done = 0;

  return chunks.map(chunk => {
    const start =
      duration * done / total;

    done += Math.max(
      1,
      chunk.length
    );

    const end =
      duration * done / total;

    return {
      start: Number(
        start.toFixed(3)
      ),

      end: Number(
        end.toFixed(3)
      ),

      text: chunk
    };
  }).filter(
    caption =>
      caption.end > caption.start
  );
}

// ========================================
// WATERMARK + CAPTION + CTA FILES
// ========================================

export async function overlayFiles(
  dir,
  script,
  opts,
  duration,
  speechSeconds = duration
) {
  const watermarkText = escapeAss(
    opts.watermark || ''
  ).slice(0, 34);

  const opacity = Math.max(
    0,
    Math.min(
      100,
      Number(opts.opacity ?? 42)
    )
  );

  const assOpacity = Math.round(
    255 * (1 - opacity / 100)
  )
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

  const ctaStart = Math.max(
    1,
    duration - 4.6
  );

  const font =
    script.language === 'hi'
      ? CFG.captionFontHi
      : CFG.captionFontEn;

  const head =
`[Script Info]
Title: ClipCraft Pro Overlays
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

  if (
    watermarkText &&
    opacity > 0
  ) {
    events +=
      `Dialogue: 10,0:00:00.00,${stamp(duration)},Watermark,,0,0,0,,` +
      `{\\alpha&H${assOpacity}&\\fad(160,200)}` +
      `${watermarkText}\n`;
  }

  // CAPTIONS

  const captions =
    opts.captions === false
      ? []
      : captionSegments(
          script,
          speechSeconds
        );

  for (const caption of captions) {
    const label = escapeAss(
      caption.text
    );

    events +=
      `Dialogue: 5,${stamp(caption.start)},${stamp(caption.end)},` +
      `Caption,,0,0,0,,` +
      `{\\q2\\fad(70,90)` +
      `\\t(0,135,\\fscx104\\fscy104)` +
      `\\t(135,320,\\fscx100\\fscy100)}` +
      `${label}\n`;
  }

  // LIKE / SUBSCRIBE / BELL

  if (
    opts.cta !== false &&
    duration > 7
  ) {
    const bits = [
      {
        a: ctaStart,
        b: ctaStart + 1.05,
        text: 'SUBSCRIBE',
        col: '&H002B6BFF&'
      },

      {
        a: ctaStart + 1.28,
        b: ctaStart + 2.35,
        text: 'LIKE',
        col: '&H00FFF0FF&'
      },

      {
        a: ctaStart + 2.62,
        b: Math.min(
          duration,
          ctaStart + 3.82
        ),
        text: 'BELL ON',
        col: '&H0000F7FF&'
      }
    ];

    for (const bit of bits) {
      events +=
        `Dialogue: 12,${stamp(bit.a)},${stamp(bit.b)},CTA,,0,0,0,,` +
        `{\\c${bit.col}\\pos(360,1135)` +
        `\\fscx88\\fscy88` +
        `\\t(0,170,\\fscx116\\fscy116)` +
        `\\t(170,340,\\fscx100\\fscy100)` +
        `\\fad(80,140)}` +
        `${bit.text}\n`;
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
  let index = 0;

  for (const caption of captions) {
    srt +=
      `${++index}\n` +
      `${srtStamp(caption.start)} --> ${srtStamp(caption.end)}\n` +
      `${caption.text}\n\n`;
  }

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

// ========================================
// PREPARE CONTINUOUS VOICE
// ========================================

export async function assembleNarration(
  dir,
  script,
  rawPaths,
  duration
) {
  if (rawPaths.length !== 1) {
    throw new Error(
      'Expected exactly one continuous Cartesia WAV'
    );
  }

  const original = await durationOf(
    rawPaths[0]
  );

  const narration = join(
    dir,
    'narration.wav'
  );

  // Do NOT pad the first WAV to the video length.
  // The final renderer decides both video and
  // voice timing together.

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

      narration
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

  return narration;
}

// ========================================
// FINAL VIDEO RENDER
// ========================================

export async function renderVideo(
  dir,
  inputPath,
  voicePath,
  script,
  opts,
  info
) {
  const sourceSeconds =
    info.duration;

  let voiceSeconds;

  try {
    const timing = JSON.parse(
      await readFile(
        join(
          dir,
          'narration-timing.json'
        ),
        'utf8'
      )
    );

    voiceSeconds =
      timing.rawSeconds;

  } catch {
    voiceSeconds = await durationOf(
      voicePath
    );
  }

  // SAME PLAN for video and audio.
  const plan = audioFitPlan(
    voiceSeconds,
    sourceSeconds,
    opts.voiceStyle
  );

  if (!plan.canRender) {
    throw new Error(
      `Narration ${voiceSeconds.toFixed(1)}s cannot be matched to ` +
      `${sourceSeconds.toFixed(1)}s without abrupt cuts or ` +
      `a long silent ending. Automatic Gemini rewrite ` +
      `was unable to produce a usable take. ` +
      `Try Regenerate Script. ` +
      `No misleading partial MP4 was exported.`
    );
  }

  const duration =
    plan.outputSeconds;

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
    inputPath,

    '-i',
    voicePath
  ];

  // Optional music.
  const musicPath = join(
    process.cwd(),
    'assets',
    'background.mp3'
  );

  const customMusic = await access(
    musicPath
  ).then(
    () => musicPath,
    () => ''
  );

  const renderMusic =
    customMusic ||
    await createEnergeticMusicBed(
      dir,
      duration
    );

  const ctaSfx =
    opts.cta !== false && duration > 7
      ? await createCtaSfx(
          dir,
          duration
        )
      : '';

  const hasMusic = Boolean(
    renderMusic
  );

  const hasCtaSfx = Boolean(
    ctaSfx
  );

  if (
    hasMusic &&
    customMusic
  ) {
    args.push(
      '-stream_loop',
      '-1',
      '-i',
      renderMusic
    );

  } else if (hasMusic) {
    args.push(
      '-i',
      renderMusic
    );
  }

  const sfxIndex =
    hasMusic ? 3 : 2;

  if (hasCtaSfx) {
    args.push(
      '-i',
      ctaSfx
    );
  }

  // VIDEO FIT

  const fit = opts.fit === 'contain'
    ? 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x10131C'
    : 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280';

  const cover =
    opts.coverOriginalCaptions === true
      ? ',drawbox=x=0:y=875:w=iw:h=190:color=0x151A22@0.90:t=fill'
      : '';

  // VOICE FILTER:
  // Pitch-preserving tempo.
  // Light compression for consistent loudness.

  const voiceFx =
    'aresample=48000,' +

    `atempo=${plan.tempo.toFixed(5)},` +

    'acompressor=threshold=0.075:ratio=3.0:attack=4:release=75,' +

    'equalizer=f=3300:t=q:w=1.1:g=3.2,' +

    'volume=1.18,' +

    `atrim=duration=${duration.toFixed(4)},` +

    'apad,' +

    `atrim=duration=${duration.toFixed(4)}`;

  // Speed up ALL source frames with setpts.
  // Fast Explainer style uses a higher
  // minimum video rate.

  let filter =
    `[0:v]` +

    `setpts=(PTS-STARTPTS)/${plan.videoRate.toFixed(6)},` +

    `fps=30,${fit},setsar=1${cover},` +

    'ass=overlays.ass,format=yuv420p[v];' +

    `[1:a]${voiceFx}` +

    (
      hasMusic
        ? ',asplit=2[nmix][nside]'
        : '[nar]'
    ) +

    ';';

  const audios = [
    hasMusic ? '[nmix]' : '[nar]'
  ];

  // ORIGINAL BACKGROUND SOUND

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

    audios.push('[amb]');
  }

  // BACKGROUND MUSIC

  if (hasMusic) {
    filter +=
      '[2:a]aresample=48000,' +

      'volume=0.16,' +

      `atrim=duration=${duration.toFixed(4)}` +

      '[music];';

    filter +=
      '[music][nside]' +

      'sidechaincompress=' +

      'threshold=0.025:' +

      'ratio=8:' +

      'attack=25:' +

      'release=280' +

      '[duck];';

    audios.push('[duck]');
  }

  // CTA SOUND EFFECTS

  if (hasCtaSfx) {
    filter +=
      `[${sfxIndex}:a]` +

      'aresample=48000,' +

      'volume=0.18,' +

      `atrim=duration=${duration.toFixed(4)}` +

      '[sfx];';

    audios.push('[sfx]');
  }

  // FINAL AUDIO MIX

  filter +=
    audios.join('') +

    `amix=inputs=${audios.length}:duration=first:normalize=0,` +

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

  // Save actual export timing for diagnostics.
  await writeFile(
    join(
      dir,
      'render-timing.json'
    ),
    JSON.stringify(
      {
        sourceSeconds,
        voiceSeconds,

        finalSeconds:
          duration,

        visualSpeed:
          plan.videoRate,

        voiceTempo:
          plan.tempo,

        speechSeconds:
          plan.speechEnd,

        remainingSeconds:
          plan.remainingSeconds,

        style:
          opts.voiceStyle ||
          'viral_funny'
      },
      null,
      2
    )
  );

  return output;
}

// ========================================
// MUSIC BED
// ========================================

async function createEnergeticMusicBed(
  dir,
  duration
) {
  const bed = join(
    dir,
    'energetic-bed.wav'
  );

  const seconds = Math.max(
    3,
    Number(duration) || 3
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
        `aevalsrc=${expression}:s=48000:d=${seconds.toFixed(4)}`,

        '-af',
        'alimiter=limit=0.70',

        '-ac',
        '1',

        '-ar',
        '48000',

        '-c:a',
        'pcm_s16le',

        bed
      ],
      {
        timeoutMs: 35000
      }
    );

    await access(bed);

    return bed;

  } catch {
    return '';
  }
}

// ========================================
// LIKE / SUBSCRIBE / BELL SOUNDS
// ========================================

async function createCtaSfx(
  dir,
  duration
) {
  const sfx = join(
    dir,
    'cta-sfx.wav'
  );

  const d = Math.max(
    3,
    Number(duration) || 3
  );

  const ctaStart = Math.max(
    1,
    d - 4.6
  );

  const hit = (
    at,
    len,
    hz,
    gain = 0.18
  ) =>
    `${gain}*sin(2*PI*${hz}*(t-${at.toFixed(3)}))*` +

    `if(between(t\\,${at.toFixed(3)}\\,${(at + len).toFixed(3)})\\,` +

    `exp(-(t-${at.toFixed(3)})*26)\\,0)`;

  const expression = [
    // Subscribe soft pop.
    hit(
      ctaStart + 0.18,
      0.18,
      185,
      0.18
    ),

    hit(
      ctaStart + 0.20,
      0.11,
      420,
      0.07
    ),

    // Like two taps.
    hit(
      ctaStart + 1.44,
      0.08,
      720,
      0.10
    ),

    hit(
      ctaStart + 1.53,
      0.08,
      980,
      0.08
    ),

    // Bell ring.
    hit(
      ctaStart + 2.82,
      0.42,
      1180,
      0.10
    ),

    hit(
      ctaStart + 2.84,
      0.36,
      1580,
      0.055
    )
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
        `aevalsrc=${expression}:s=48000:d=${d.toFixed(4)}`,

        '-af',
        'alimiter=limit=0.48',

        '-ac',
        '1',

        '-ar',
        '48000',

        '-c:a',
        'pcm_s16le',

        sfx
      ],
      {
        timeoutMs: 35000
      }
    );

    await access(sfx);

    return sfx;

  } catch {
    return '';
  }
}

// ========================================
// YOUTUBE METADATA
// ========================================

export async function writeMetadata(
  dir,
  script
) {
  const metadata =
    script.metadata;

  const sources = Array.isArray(
    metadata.sources
  )
    ? metadata.sources.map(
        source =>
          `${source.title}: ${source.url}`
      ).join('\n')
    : '';

  const narration = script.beats
    .map(
      beat =>
        `[${beat.start.toFixed(1)}s–${beat.end.toFixed(1)}s] ` +
        beat.text
    )
    .join('\n');

  const text =
    `${metadata.title}\n\n` +

    `DESCRIPTION\n` +
    `${metadata.description}\n\n` +

    `TAGS\n` +
    `${metadata.tags.join(', ')}\n\n` +

    `NARRATION\n` +
    `${narration}\n\n` +

    `OPTIONAL RESEARCH LEADS (verify before publishing)\n` +

    `${sources || 'No external facts fetched'}\n`;

  await writeFile(
    join(
      dir,
      'metadata.txt'
    ),
    text
  );

  await writeFile(
    join(
      dir,
      'script.json'
    ),
    JSON.stringify(
      script,
      null,
      2
    )
  );
}
