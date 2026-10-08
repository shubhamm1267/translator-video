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
  // Character-dialogue tracks are padded to the full video timeline.
  // For rewrite decisions use ACTIVE SPEECH time from the sidecar so
  // sparse comedy dialogue cannot masquerade as a full-length voiceover.
  try {
    const timing = JSON.parse(
      await readFile(`${file}.timing.json`, 'utf8')
    );

    const speechSeconds = Number(
      timing?.speechSeconds
    );

    if (
      timing?.timelineSynced === true &&
      Number.isFinite(speechSeconds) &&
      speechSeconds > 0
    ) {
      return speechSeconds;
    }
  } catch {
    // Ordinary audio file.
  }

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

  const full = Number(
    stdout.trim()
  );

  if (
    !Number.isFinite(full) ||
    full <= 0
  ) {
    throw new Error(
      'Cannot read audio duration'
    );
  }

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
    ].map(
      x => +x[1]
    );

    const ends = [
      ...stderr.matchAll(
        /silence_end:\s*([0-9.]+)/g
      )
    ].map(
      x => +x[1]
    );

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
    // Use full duration.
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

function chunkWords(
  words,
  lang
) {
  const chars =
    lang === 'hi'
      ? 16
      : 18;

  const result = [];
  const current = [];

  for (const word of words) {
    if (
      current.length &&
      (
        current.length >= 3 ||
        [...current, word]
          .join(' ')
          .length > chars
      )
    ) {
      result.push(
        current.join(' ')
      );

      current.length = 0;
    }

    current.push(word);
  }

  if (current.length) {
    result.push(
      current.join(' ')
    );
  }

  return result;
}

export function captionSegments(
  script,
  speechSeconds,
  voiceTiming = null
) {
  const timedSegments =
    Array.isArray(
      voiceTiming?.segments
    )
      ? voiceTiming.segments
          .map(
            segment => ({
              start:
                Number(
                  segment.start
                ),

              end:
                Number(
                  segment.spokenEnd ??
                  segment.end
                ),

              text:
                String(
                  segment.text || ''
                ).trim()
            })
          )
          .filter(
            segment =>
              segment.text &&
              Number.isFinite(
                segment.start
              ) &&
              Number.isFinite(
                segment.end
              ) &&
              segment.end >
              segment.start
          )
      : [];

  if (timedSegments.length) {
    const result = [];

    for (
      const segment
      of timedSegments
    ) {
      const words =
        segment.text
          .split(/\s+/u)
          .filter(Boolean);

      if (!words.length) {
        continue;
      }

      const chunks =
        chunkWords(
          words,
          script.language
        );

      const weights =
        chunks.map(
          text =>
            Math.max(
              1,
              [...text].length
            )
        );

      const total =
        weights.reduce(
          (
            sum,
            weight
          ) =>
            sum + weight,
          0
        );

      const span =
        Math.max(
          0.08,
          segment.end -
          segment.start
        );

      let used = 0;

      chunks.forEach(
        (
          text,
          index
        ) => {
          const start =
            segment.start +
            span *
            used /
            total;

          used +=
            weights[index];

          const end =
            segment.start +
            span *
            used /
            total;

          if (
            end >
            start
          ) {
            result.push({
              start:
                +start.toFixed(3),

              end:
                +end.toFixed(3),

              text
            });
          }
        }
      );
    }

    return result;
  }

  const beats =
    Array.isArray(
      script?.beats
    )
      ? script.beats
          .map(
            beat => ({
              start:
                Number(
                  beat.start
                ),

              end:
                Number(
                  beat.end
                ),

              text:
                String(
                  beat.text || ''
                ).trim()
            })
          )
          .filter(
            beat =>
              beat.text &&
              Number.isFinite(
                beat.start
              ) &&
              Number.isFinite(
                beat.end
              ) &&
              beat.end >
              beat.start
          )
      : [];

  if (!beats.length) {
    return [];
  }

  const full =
    Number(
      beats.at(-1)?.end ||
      0
    );

  const duration =
    speechSeconds ===
      undefined
      ? full
      : Math.min(
          full,

          Math.max(
            0,
            Number(
              speechSeconds
            ) || 0
          )
        );

  if (
    duration <= 0
  ) {
    return [];
  }

  const scale =
    full > 0
      ? duration / full
      : 1;

  const result = [];

  for (
    const beat
    of beats
  ) {
    const beatStart =
      Math.max(
        0,

        Math.min(
          duration,
          beat.start *
          scale
        )
      );

    const beatEnd =
      Math.max(
        beatStart,

        Math.min(
          duration,
          beat.end *
          scale
        )
      );

    if (
      beatEnd <=
      beatStart
    ) {
      continue;
    }

    const words =
      beat.text
        .split(/\s+/u)
        .filter(Boolean);

    const chunks =
      chunkWords(
        words,
        script.language
      );

    const weights =
      chunks.map(
        text =>
          Math.max(
            1,
            [...text].length
          )
      );

    const total =
      weights.reduce(
        (
          sum,
          weight
        ) =>
          sum + weight,
        0
      );

    let used = 0;

    chunks.forEach(
      (
        text,
        index
      ) => {
        const start =
          beatStart +
          (
            beatEnd -
            beatStart
          ) *
          used /
          total;

        used +=
          weights[index];

        const end =
          beatStart +
          (
            beatEnd -
            beatStart
          ) *
          used /
          total;

        if (
          end > start
        ) {
          result.push({
            start:
              +start.toFixed(3),

            end:
              +end.toFixed(3),

            text
          });
        }
      }
    );
  }

  return result;
}

// ====================================
// MOVIE SHORTS HEADER / LAYOUT HELPERS
// ====================================

function isMovieShorts(
  opts = {}
) {
  return (
    opts.voiceStyle ===
    'fast_explainer'
  );
}

function movieHeadlineSource(
  script
) {
  const cleanHeadline =
    value =>
      String(
        value || ''
      )
        .replace(
          /#[\p{L}\p{N}_]+/gu,
          ''
        )
        .replace(
          /\p{Extended_Pictographic}/gu,
          ''
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim();

  const candidates = [
    script?.hook,
    script?.metadata?.title,
    script?.summary
  ]
    .map(
      cleanHeadline
    )
    .filter(Boolean);

  let chosen =
    candidates[0] ||
    '';

  if (
    script?.language ===
    'hi'
  ) {
    chosen =
      candidates.find(
        text =>
          /[\u0900-\u097f]/
            .test(text)
      ) ||
      chosen;
  }

  return chosen.slice(
    0,
    72
  );
}

function movieHeadlineAss(
  script
) {
  const raw =
    movieHeadlineSource(
      script
    );

  if (!raw) {
    return '';
  }

  const words =
    raw
      .split(/\s+/u)
      .filter(Boolean)
      .slice(
        0,
        12
      );

  const stop =
    new Set([
      'this',
      'that',
      'with',
      'from',
      'into',
      'what',
      'when',
      'then',
      'the',
      'and',
      'but',
      'for',
      'her',
      'his',
      'its',
      'यह',
      'ये',
      'इस',
      'उस',
      'और',
      'लेकिन',
      'फिर',
      'को',
      'का',
      'की',
      'के',
      'ने',
      'से',
      'में',
      'पर',
      'तो',
      'अब',
      'एक',
      'कर',
      'दिया',
      'गया',
      'गई'
    ]);

  const candidates =
    words
      .map(
        (
          word,
          index
        ) => {
          const clean =
            word.replace(
              /[^\p{L}\p{N}]/gu,
              ''
            );

          return {
            index,

            key:
              clean.toLocaleLowerCase(),

            size:
              [...clean].length
          };
        }
      )
      .filter(
        x =>
          x.size >= 3 &&
          !stop.has(
            x.key
          )
      )
      .sort(
        (
          a,
          b
        ) =>
          b.size -
          a.size ||
          a.index -
          b.index
      )
      .slice(
        0,
        words.length <= 5
          ? 2
          : 3
      );

  const highlighted =
    new Set(
      candidates.map(
        x => x.index
      )
    );

  const lengths =
    words.map(
      x =>
        [...x].length +
        1
    );

  const total =
    lengths.reduce(
      (
        a,
        b
      ) =>
        a + b,
      0
    );

  let breakAfter =
    -1;

  let used = 0;

  if (
    words.length >= 5 ||
    total > 27
  ) {
    for (
      let i = 0;
      i <
      words.length - 1;
      i++
    ) {
      used +=
        lengths[i];

      if (
        used >=
        total / 2
      ) {
        breakAfter =
          i;

        break;
      }
    }
  }

  return words
    .map(
      (
        word,
        index
      ) => {
        const safe =
          escapeAss(
            word
          );

        const painted =
          highlighted.has(
            index
          )
            ? (
                `{\\c&H0000FFFF&}` +
                `${safe}` +
                `{\\c&H00FFFFFF&}`
              )
            : safe;

        return (
          index ===
          breakAfter
        )
          ? `${painted}\\N`
          : painted;
      }
    )
    .join(' ')
    .replace(
      /\\N\s+/g,
      '\\N'
    );
}

// ====================================
// OVERLAYS / CAPTIONS / CTA
// ====================================

export async function overlayFiles(
  dir,
  script,
  opts,
  duration,
  speechSeconds = duration,
  voiceTiming = null
) {
  const font =
    script.language ===
    'hi'
      ? CFG.captionFontHi
      : CFG.captionFontEn;

  const movieMode =
    isMovieShorts(
      opts
    );

  const movieHeadline =
    movieMode
      ? movieHeadlineAss(
          script
        )
      : '';

  const opacity =
    Math.max(
      0,

      Math.min(
        100,
        Number(
          opts.opacity ??
          42
        )
      )
    );

  const hexAlpha =
    Math.round(
      255 *
      (
        1 -
        opacity / 100
      )
    )
      .toString(16)
      .padStart(
        2,
        '0'
      )
      .toUpperCase();

  const mark =
    escapeAss(
      opts.watermark ||
      ''
    ).slice(
      0,
      34
    );

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
Style: MovieHeader,${font},39,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,8,40,40,24,1
Style: MovieBottom,DejaVu Sans,27,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,5,22,22,18,1
Style: Watermark,DejaVu Sans,22,&H00FFFFFF,&H00FFFFFF,&H000A1520,&H90000000,-1,0,0,0,100,100,0,0,1,1,1,9,20,28,36,1
Style: CTA,DejaVu Sans,39,&H00FFFFFF,&H0000FFFF,&H0020314A,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,30,30,100,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  let events = '';

  if (
    movieMode &&
    movieHeadline
  ) {
    events +=
      `Dialogue: 20,0:00:00.00,${stamp(duration)},MovieHeader,,0,0,0,,` +
      `{\\q2\\an8\\pos(360,40)}` +
      `${movieHeadline}\n`;

    events +=
      `Dialogue: 18,0:00:00.00,${stamp(duration)},MovieBottom,,0,0,0,,` +
      `{\\an1\\pos(30,1240)}` +
      `{\\c&H000000FF&}♥` +
      `{\\c&H00FFFFFF&}  LIKE\n`;

    events +=
      `Dialogue: 18,0:00:00.00,${stamp(duration)},MovieBottom,,0,0,0,,` +
      `{\\an3\\pos(690,1240)}` +
      `{\\c&H000000FF&}▶` +
      `{\\c&H00FFFFFF&}  SUBSCRIBE\n`;
  }

  if (
    mark &&
    opacity > 0
  ) {
    const watermarkPosition =
      movieMode
        ? '{\\an9\\pos(694,205)}'
        : '';

    events +=
      `Dialogue: 10,0:00:00.00,${stamp(duration)},Watermark,,0,0,0,,` +
      `${watermarkPosition}` +
      `{\\alpha&H${hexAlpha}&\\fad(160,200)}` +
      `${mark}\n`;
  }

  const captions =
    opts.captions === false
      ? []
      : captionSegments(
          script,
          speechSeconds,
          voiceTiming
        );

  for (
    const c
    of captions
  ) {
    events +=
      `Dialogue: 5,${stamp(c.start)},${stamp(c.end)},Caption,,0,0,0,,` +
      `{\\q2\\fad(70,90)` +
      `\\t(0,135,\\fscx104\\fscy104)` +
      `\\t(135,320,\\fscx100\\fscy100)}` +
      `${escapeAss(c.text)}\n`;
  }

  if (
    opts.cta !== false &&
    duration > 7
  ) {
    const first =
      Math.max(
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

    for (
      const b
      of animations
    ) {
      events +=
        `Dialogue: 12,${stamp(b.a)},${stamp(b.z)},CTA,,0,0,0,,` +
        `{\\c${b.c}` +
        `\\pos(360,1135)` +
        `\\fscx88\\fscy88` +
        `\\t(0,170,\\fscx116\\fscy116)` +
        `\\t(170,340,\\fscx100\\fscy100)` +
        `\\fad(80,140)}` +
        `${b.t}\n`;
    }
  }

  const ass =
    join(
      dir,
      'overlays.ass'
    );

  await writeFile(
    ass,
    head + events,
    'utf8'
  );

  let srt = '';

  captions.forEach(
    (
      c,
      i
    ) => {
      srt +=
        `${i + 1}\n` +
        `${srtStamp(c.start)} --> ${srtStamp(c.end)}\n` +
        `${c.text}\n\n`;
    }
  );

  await writeFile(
    join(
      dir,
      'captions.srt'
    ),
    srt,
    'utf8'
  );

  return {
    ass,
    captions:
      captions.length
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
  if (
    rawPaths.length !== 1
  ) {
    throw new Error(
      'Expected one continuous Cartesia WAV'
    );
  }

  const original =
    await durationOf(
      rawPaths[0]
    );

  const output =
    join(
      dir,
      'narration.wav'
    );

  let dialogueTiming =
    null;

  try {
    dialogueTiming =
      JSON.parse(
        await readFile(
          `${rawPaths[0]}.timing.json`,
          'utf8'
        )
      );

  } catch {
    dialogueTiming =
      null;
  }

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
      timeoutMs:
        120000
    }
  );

  await writeFile(
    join(
      dir,
      'narration-timing.json'
    ),

    JSON.stringify(
      {
        rawSeconds:
          original,

        videoSeconds:
          duration,

        method:
          dialogueTiming?.timelineSynced
            ? 'character-dialogue-timeline'
            : 'video-and-audio-timebase',

        timelineSynced:
          dialogueTiming?.timelineSynced ===
          true,

        speechSeconds:
          dialogueTiming?.speechSeconds ??
          original,

        coverage:
          dialogueTiming?.coverage ??
          null,

        maxGap:
          dialogueTiming?.maxGap ??
          null,

        averageGap:
          dialogueTiming?.averageGap ??
          null,

        assignments:
          dialogueTiming?.assignments ||
          {},

        segments:
          Array.isArray(
            dialogueTiming?.segments
          )
            ? dialogueTiming.segments
            : []
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

async function optionalMusic(
  dir,
  duration
) {
  const music =
    join(
      process.cwd(),
      'assets',
      'background.mp3'
    );

  if (
    await access(
      music
    ).then(
      () => true,
      () => false
    )
  ) {
    return {
      path: music,
      loop: true
    };
  }

  const generated =
    join(
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
        timeoutMs:
          35000
      }
    );

    return {
      path:
        generated,

      loop:
        false
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
  const path =
    join(
      dir,
      'cta-sfx.wav'
    );

  const start =
    Math.max(
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
    hit(
      start + 0.18,
      0.18,
      185,
      0.18
    ),

    hit(
      start + 0.20,
      0.11,
      420,
      0.07
    ),

    hit(
      start + 1.44,
      0.08,
      720,
      0.10
    ),

    hit(
      start + 1.53,
      0.08,
      980,
      0.08
    ),

    hit(
      start + 2.82,
      0.42,
      1180,
      0.10
    ),

    hit(
      start + 2.84,
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
        timeoutMs:
          35000
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
  let timingData =
    null;

  try {
    timingData =
      JSON.parse(
        await readFile(
          join(
            dir,
            'narration-timing.json'
          ),
          'utf8'
        )
      );

    voiceSeconds =
      Number(
        timingData.rawSeconds
      );

  } catch {
    voiceSeconds =
      await durationOf(
        voice
      );
  }

  if (
    !Number.isFinite(
      voiceSeconds
    ) ||
    voiceSeconds <= 0
  ) {
    voiceSeconds =
      await durationOf(
        voice
      );
  }

  const timelineSynced =
    opts.voiceStyle ===
      'viral_funny' &&
    timingData?.timelineSynced ===
      true;

  const plan =
    timelineSynced
      ? {
          canRender: true,
          needsRewrite: false,
          outputSeconds:
            info.duration,
          targetSeconds:
            info.duration,
          videoRate: 1,
          tempo: 1,
          speechEnd:
            info.duration,
          remainingSeconds: 0,
          excessSeconds: 0,
          ratio:
            voiceSeconds /
            info.duration
        }

      : audioFitPlan(
          voiceSeconds,
          info.duration,
          opts.voiceStyle
        );

  if (
    !plan.canRender
  ) {
    throw new Error(
      `Narration ${voiceSeconds.toFixed(1)}s cannot fit ` +
      `${info.duration.toFixed(1)}s video without a ` +
      'long silent ending or cut-off. ' +
      'Use Regenerate Script.'
    );
  }

  const duration =
    plan.outputSeconds;

  await overlayFiles(
    dir,
    script,
    opts,
    duration,
    plan.speechEnd,
    timelineSynced
      ? timingData
      : null
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

  const musicSource =
    await optionalMusic(
      dir,
      duration
    );

  const music =
    musicSource.path;

  const sfx =
    opts.cta !== false &&
    duration > 7
      ? await createCtaSfx(
          dir,
          duration
        )
      : '';

  if (music) {
    if (
      musicSource.loop
    ) {
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

  const movieMode =
    isMovieShorts(
      opts
    );

  const movieFill =
    'scale=720:960:' +
    'force_original_aspect_ratio=increase,' +

    'crop=720:960,' +

    'pad=720:1280:' +
    '0:180:' +
    'color=0x050505,' +

    'drawbox=' +
    'x=0:' +
    'y=0:' +
    'w=iw:' +
    'h=180:' +
    'color=0x000000@0.94:' +
    't=fill,' +

    'drawbox=' +
    'x=0:' +
    'y=176:' +
    'w=iw:' +
    'h=4:' +
    'color=0xE51B23@0.96:' +
    't=fill,' +

    'drawbox=' +
    'x=0:' +
    'y=1140:' +
    'w=iw:' +
    'h=140:' +
    'color=0x000000@0.94:' +
    't=fill,' +

    'drawbox=' +
    'x=0:' +
    'y=1136:' +
    'w=iw:' +
    'h=4:' +
    'color=0xE51B23@0.96:' +
    't=fill';

  const movieContain =
    'scale=720:960:' +
    'force_original_aspect_ratio=increase,' +

    'crop=720:960,' +

    'boxblur=8:5,' +

    'pad=720:1280:' +
    '0:180:' +
    'color=0x050505,' +

    'drawbox=' +
    'x=0:' +
    'y=0:' +
    'w=iw:' +
    'h=180:' +
    'color=0x000000@0.94:' +
    't=fill,' +

    'drawbox=' +
    'x=0:' +
    'y=176:' +
    'w=iw:' +
    'h=4:' +
    'color=0xE51B23@0.96:' +
    't=fill,' +

    'drawbox=' +
    'x=0:' +
    'y=1140:' +
    'w=iw:' +
    'h=140:' +
    'color=0x000000@0.94:' +
    't=fill,' +

    'drawbox=' +
    'x=0:' +
    'y=1136:' +
    'w=iw:' +
    'h=4:' +
    'color=0xE51B23@0.96:' +
    't=fill';

  const fit =
    movieMode
      ? (
          opts.fit ===
            'contain'
            ? movieContain
            : movieFill
        )

      : opts.fit ===
        'contain'
        ? (
            'scale=720:1280:' +
            'force_original_aspect_ratio=decrease,' +
            'pad=720:1280:' +
            '(ow-iw)/2:' +
            '(oh-ih)/2:' +
            'color=0x10131C'
          )

        : (
            'scale=720:1280:' +
            'force_original_aspect_ratio=increase,' +
            'crop=720:1280'
          );

  const cover =
    opts.coverOriginalCaptions ===
      true
      ? (
          ',drawbox=' +
          'x=0:' +
          'y=875:' +
          'w=iw:' +
          'h=190:' +
          'color=0x151A22@0.90:' +
          't=fill'
        )
      : '';

  const voiceFx =
    'aresample=48000,' +

    (
      timelineSynced
        ? ''
        : `atempo=${plan.tempo.toFixed(5)},`
    ) +

    'acompressor=' +
    'threshold=0.075:' +
    'ratio=3:' +
    'attack=4:' +
    'release=75,' +

    'equalizer=' +
    'f=3300:' +
    't=q:' +
    'w=1.1:' +
    'g=3.2,' +

    'volume=1.18,' +

    `atrim=duration=${duration.toFixed(4)},` +

    'apad,' +

    `atrim=duration=${duration.toFixed(4)}`;

  let filter =
    `[0:v]` +

    `setpts=(PTS-STARTPTS)/${plan.videoRate.toFixed(6)},` +

    'fps=30,' +

    `${fit},` +

    'setsar=1' +

    `${cover},` +

    'ass=overlays.ass,' +

    'format=yuv420p' +

    '[v];' +

    `[1:a]` +

    `${voiceFx}` +

    (
      music
        ? ',asplit=2[nmix][nside]'
        : '[nar]'
    ) +

    ';';

  const streams = [
    music
      ? '[nmix]'
      : '[nar]'
  ];

  if (
    opts.originalAudio ===
      true &&
    info.hasAudio
  ) {
    filter +=
      `[0:a]` +

      'aresample=48000,' +

      `atempo=${plan.videoRate.toFixed(5)},` +

      'volume=0.07,' +

      `atrim=duration=${duration.toFixed(4)},` +

      'apad,' +

      `atrim=duration=${duration.toFixed(4)}` +

      '[amb];';

    streams.push(
      '[amb]'
    );
  }

  if (music) {
    filter +=
      `[2:a]` +

      'aresample=48000,' +

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

    streams.push(
      '[duck]'
    );
  }

  if (sfx) {
    const idx =
      music
        ? 3
        : 2;

    filter +=
      `[${idx}:a]` +

      'aresample=48000,' +

      'volume=0.18,' +

      `atrim=duration=${duration.toFixed(4)}` +

      '[sfx];';

    streams.push(
      '[sfx]'
    );
  }

  filter +=
    streams.join('') +

    `amix=` +
    `inputs=${streams.length}:` +
    `duration=first:` +
    `normalize=0,` +

    'loudnorm=' +
    'I=-14:' +
    'TP=-1.0:' +
    'LRA=7,' +

    'alimiter=' +
    'limit=0.95,' +

    'apad,' +

    `atrim=duration=${duration.toFixed(4)}` +

    '[a]';

  const output =
    join(
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
      timeoutMs:
        600000
    }
  );

  await access(
    output
  );

  await writeFile(
    join(
      dir,
      'render-timing.json'
    ),

    JSON.stringify(
      {
        sourceSeconds:
          info.duration,

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
          'viral_funny',

        movieShortsLayout:
          movieMode,

        timelineSynced,

        dialogueCoverage:
          timingData?.coverage ??
          null,

        maxDialogueGap:
          timingData?.maxGap ??
          null,

        averageDialogueGap:
          timingData?.averageGap ??
          null
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
  const m =
    script.metadata ||
    {};

  const sources =
    Array.isArray(
      m.sources
    )
      ? m.sources
          .map(
            x =>
              `${x.title}: ${x.url}`
          )
          .join('\n')
      : '';

  const narration =
    (
      script.beats ||
      []
    )
      .map(
        x =>
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