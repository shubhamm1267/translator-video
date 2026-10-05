import http from 'node:http';

import { randomUUID } from 'node:crypto';

import {
  mkdir,
  rm,
  stat
} from 'node:fs/promises';

import {
  createWriteStream,
  createReadStream
} from 'node:fs';

import { Transform } from 'node:stream';

import { pipeline } from 'node:stream/promises';

import {
  resolve,
  join
} from 'node:path';

import { CFG } from './env.mjs';

import {
  audioFitPlan
} from './audio-fit.mjs';

import {
  cmd,
  probe,
  renderVideo,
  assembleNarration,
  durationOf,
  writeMetadata
} from './media.mjs';

import {
  analyzeVideo,
  generateScriptFromContext,
  cartesiaVoices,
  speakCartesia,
  validateScript,
  retimeScriptForVoice,
  GEMINI_MODELS
} from './ai.mjs';

// ==========================================
// STORAGE
// ==========================================

const workBase = resolve(
  process.cwd(),
  'work'
);

const workRoot = join(
  workBase,
  'jobs'
);

if (CFG.purgeWorkOnStart) {
  await rm(workBase, {
    recursive: true,
    force: true
  });
}

await mkdir(
  workRoot,
  { recursive: true }
);

const jobs = new Map();

const MAX_ACTIVE = 2;

// ==========================================
// HELPERS
// ==========================================

function safeDownloadName(value) {
  return String(value || 'clipcraft-video')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) ||
    'clipcraft-video';
}

function asciiDownloadName(value) {
  const safe = safeDownloadName(value)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/[^A-Za-z0-9 ._()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);

  return safe || 'clipcraft-video';
}

function encodeHeaderFilename(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, char =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

function contentDisposition(
  disposition,
  title,
  extension
) {
  const safeTitle =
    safeDownloadName(title);

  const asciiTitle =
    asciiDownloadName(title);

  const unicodeFilename =
    `${safeTitle}.${extension}`;

  const asciiFilename =
    `${asciiTitle}.${extension}`;

  return (
    `${disposition}; ` +
    `filename="${asciiFilename}"; ` +
    `filename*=UTF-8''${encodeHeaderFilename(unicodeFilename)}`
  );
}

function parseByteRange(
  value,
  size
) {
  const match =
    /^bytes=(\d*)-(\d*)$/
      .exec(String(value || '').trim());

  if (!match) {
    return null;
  }

  let start;
  let end;

  if (!match[1] && match[2]) {
    const suffix =
      Number(match[2]);

    if (
      !Number.isInteger(suffix) ||
      suffix <= 0
    ) {
      return null;
    }

    start =
      Math.max(0, size - suffix);

    end =
      size - 1;

  } else {
    start =
      Number(match[1]);

    end = match[2]
      ? Number(match[2])
      : size - 1;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(
      end,
      size - 1
    )
  };
}

const hasKeys = keys => Boolean(
  (keys?.geminiKey || CFG.geminiKey) &&
  (keys?.cartesiaKey || CFG.cartesiaKey)
);

const json = (
  res,
  code,
  data
) => {
  res.writeHead(
    code,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Cache-Control':
        'no-store'
    }
  );

  res.end(
    JSON.stringify(data)
  );
};

const message = error => {
  const text = String(
    error?.message ||
    error ||
    'Unknown error'
  );

  if (
    /prohibited_content|prohibited use policy|input blocked/i
      .test(text)
  ) {
    return (
      'Gemini blocked this video because its safety filter ' +
      'flagged the footage. Try a different clip, trim the ' +
      'sensitive part, or set STORYBOARD_SCAN=false and restart.'
    );
  }

  return text
    .replace(
      /sk_car_[A-Za-z0-9_-]+/g,
      '[REDACTED_KEY]'
    )
    .slice(0, 1200);
};

function cors(req, res) {
  const origin =
    req.headers.origin;

  if (
    !origin ||
    CFG.origin
      .split(',')
      .map(x => x.trim())
      .includes(origin)
  ) {
    if (origin) {
      res.setHeader(
        'Access-Control-Allow-Origin',
        origin
      );
    }

    res.setHeader(
      'Vary',
      'Origin'
    );

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type,X-Options,X-Client-Keys'
    );
  }
}

function readClientKeys(req) {
  try {
    const raw = String(
      req.headers['x-client-keys'] || ''
    );

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(
      Buffer.from(
        raw,
        'base64url'
      ).toString('utf8')
    );

    const safeKey = value => {
      const key = String(
        value || ''
      ).trim();

      return /^[A-Za-z0-9_.-]{10,240}$/
        .test(key)
          ? key
          : '';
    };

    return {
      geminiKey:
        safeKey(parsed.geminiKey),

      cartesiaKey:
        safeKey(parsed.cartesiaKey)
    };

  } catch {
    return {};
  }
}

function cleanOptions(o = {}) {
  const language =
    o.language === 'hi'
      ? 'hi'
      : 'en';

  const defaultVoice =
    language === 'hi'
      ? CFG.cartesiaHindiVoice
      : CFG.cartesiaVoice;

  const voiceStyle = [
    'viral_funny',
    'facts_explainer',
    'story_narrator',
    'fast_explainer',
    'dramatic_reveal',
    'clean'
  ].includes(o.voiceStyle)
    ? o.voiceStyle
    : 'viral_funny';

  return {
    language,

    geminiModel:
      GEMINI_MODELS.includes(o.geminiModel)
        ? o.geminiModel
        : CFG.geminiModel,

    tone: [
      'funny',
      'curious',
      'wholesome'
    ].includes(o.tone)
      ? o.tone
      : 'funny',

    voiceStyle,

    watermark: String(
      o.watermark ?? ''
    )
      .replace(/[\r\n]/g, ' ')
      .slice(0, 35),

    opacity: Math.min(
      100,
      Math.max(
        0,
        Number(o.opacity ?? 42) || 0
      )
    ),

    captions:
      o.captions !== false,

    coverOriginalCaptions:
      o.coverOriginalCaptions === true,

    cta:
      o.cta !== false,

    originalAudio:
      o.originalAudio === true,

    fit:
      o.fit === 'contain'
        ? 'contain'
        : 'fill',

    voiceId:
      /^[a-zA-Z0-9_-]{1,80}$/
        .test(String(o.voiceId || ''))
        ? String(o.voiceId)
        : defaultVoice,

    review:
      o.review === true
  };
}

function externalJob(j) {
  return {
    id: j.id,

    status: j.status,
    step: j.step,
    percent: j.percent,

    error:
      j.error || null,

    scriptRevision:
      j.scriptRevision || 0,

    hasAnalysis:
      !!j.context,

    info:
      j.info || null,

    script:
      j.script || null,

    options:
      j.options,

    videoUrl:
      j.status === 'done'
        ? `/api/jobs/${j.id}/file/video`
        : null,

    captionsUrl:
      j.status === 'done'
        ? `/api/jobs/${j.id}/file/captions`
        : null,

    metadataUrl:
      j.status === 'done'
        ? `/api/jobs/${j.id}/file/metadata`
        : null,

    createdAt:
      j.createdAt
  };
}

function progress(
  j,
  step,
  percent,
  status
) {
  j.step = step;
  j.percent = percent;

  if (status) {
    j.status = status;
  }
}

// ==========================================
// VIDEO INPUT
// ==========================================

async function inputToMp4(
  j,
  filePath,
  mimetype
) {
  if (mimetype === 'video/mp4') {
    return filePath;
  }

  progress(
    j,
    'Converting your video to MP4 for Gemini…',
    9
  );

  const converted = join(
    j.dir,
    'normalized.mp4'
  );

  await cmd(
    CFG.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',

      '-i',
      filePath,

      '-map',
      '0:v:0',

      '-map',
      '0:a:0?',

      '-c:v',
      'libx264',

      '-preset',
      'veryfast',

      '-crf',
      '24',

      '-c:a',
      'aac',

      '-movflags',
      '+faststart',

      converted
    ],
    {
      timeoutMs: 300000
    }
  );

  return converted;
}

// ==========================================
// RENDER JOB
// ==========================================

async function renderJob(j) {
  try {
    progress(
      j,
      'Cartesia is generating one continuous voiceover…',
      52,
      'rendering'
    );

    const originalScript =
      structuredClone(j.script);

    let chosenScript =
      originalScript;

    let bestVoice = null;

    let bestDistance =
      Number.POSITIVE_INFINITY;

    let autoPolished = false;

    // Actual TTS audio length determines
    // whether narration should be corrected.
    //
    // Attempt a maximum of three takes:
    // original + two optional rewrites.

    for (
      let take = 0;
      take < 3;
      take++
    ) {
      const voiceFile = join(
        j.dir,
        `cartesia-take-${take + 1}.wav`
      );

      const fullText =
        chosenScript.beats
          .map(beat => beat.text.trim())
          .filter(Boolean)
          .join(' ');

      if (!fullText) {
        throw new Error(
          'AI generated an empty narration'
        );
      }

      try {
        await speakCartesia(
          fullText,
          j.options.language,
          j.options.voiceId,
          voiceFile,
          j.options,
          j.providerKeys
        );

      } catch (error) {
        if (bestVoice) {
          console.warn(
            `[job ${j.id}] another voice take unavailable: ${message(error)}`
          );

          break;
        }

        throw error;
      }

      const seconds =
        await durationOf(voiceFile);

      // Voice style now affects BOTH
      // the audio fitting and video speed.
      const fit = audioFitPlan(
        seconds,
        j.info.duration,
        j.options.voiceStyle
      );

      const gapPenalty =
        fit.remainingSeconds > 0.65
          ? (
              fit.remainingSeconds /
              Math.max(1, j.info.duration)
            )
          : 0;

      // Always prioritize a renderable take
      // over a take with an impossible
      // tempo or a truncated ending.

      const distance =
        (fit.canRender ? 0 : 10) +
        Math.abs(
          Math.log(fit.ratio)
        ) +
        gapPenalty * 3.5;

      if (
        distance < bestDistance
      ) {
        bestDistance = distance;
        bestVoice = voiceFile;

        j.script =
          chosenScript;
      }

      if (!fit.needsRewrite) {
        break;
      }

      if (
        take === 2 ||
        !j.context
      ) {
        break;
      }

      progress(
        j,
        `Voice ${seconds.toFixed(1)}s / video ${j.info.duration.toFixed(1)}s — correcting automatically…`,
        74
      );

      try {
        const polished =
          await retimeScriptForVoice(
            j.context,
            chosenScript,
            j.info.duration,
            seconds,
            j.options,

            (
              step,
              percentage
            ) =>
              progress(
                j,
                step,
                percentage,
                'rendering'
              ),

            j.providerKeys
          );

        if (!polished) {
          break;
        }

        chosenScript =
          polished;

        autoPolished = true;

      } catch (error) {
        // Preserve the best recording
        // if an optional Gemini request fails.

        console.warn(
          `[job ${j.id}] optional auto-polish unavailable: ${message(error)}`
        );

        break;
      }
    }

    if (!bestVoice) {
      throw new Error(
        'Cartesia did not produce a usable voiceover'
      );
    }

    progress(
      j,
      'Synchronizing actual narration and video speed…',
      80
    );

    const voice =
      await assembleNarration(
        j.dir,
        j.script,
        [bestVoice],
        j.info.duration
      );

    const fitInfo =
      audioFitPlan(
        await durationOf(bestVoice),
        j.info.duration,
        j.options.voiceStyle
      );

    if (autoPolished) {
      j.scriptRevision =
        (j.scriptRevision || 1) + 1;

      j.scriptHistory = [
        ...(j.scriptHistory || []),
        structuredClone(j.script)
      ].slice(-8);
    }

    await writeMetadata(
      j.dir,
      j.script
    );

    progress(
      j,
      'Rendering synced captions, watermark and overlays…',
      87
    );

    await renderVideo(
      j.dir,
      j.inputPath,
      voice,
      j.script,
      j.options,
      j.info
    );

    const note =
      fitInfo.remainingSeconds > 2.2
        ? ` Voice ends ${fitInfo.remainingSeconds.toFixed(1)}s before the clip.`
        : '';

    j.completedAt = Date.now();

    progress(
      j,
      `Video ready.${note} Temporary files auto-delete in ${Math.round(CFG.outputTtl / 60000)} minutes.`,
      100,
      'done'
    );

    j.error = null;

  } catch (error) {
    progress(
      j,
      'Rendering failed.',
      j.percent,
      'error'
    );

    j.error =
      message(error);

    console.error(
      `[job ${j.id}]`,
      j.error
    );
  }
}

// ==========================================
// ANALYZE
// ==========================================

async function analyzeJob(j) {
  try {
    progress(
      j,
      'Validating and reading the video…',
      7,
      'analyzing'
    );

    j.inputPath =
      await inputToMp4(
        j,
        j.originalPath,
        j.mime
      );

    j.info =
      await probe(
        j.inputPath
      );

    progress(
      j,
      'Uploading to Google Gemini Files API…',
      12
    );

    const first =
      await analyzeVideo(
        j.inputPath,
        j.info.duration,
        j.options,

        (
          step,
          percent
        ) =>
          progress(
            j,
            step,
            percent
          ),

        j.providerKeys
      );

    j.script = first.script;

    j.context = first.context;

    j.scriptHistory = [
      structuredClone(first.script)
    ];

    j.scriptRevision = 1;

    await writeMetadata(
      j.dir,
      j.script
    );

    if (j.options.review) {
      progress(
        j,
        'Script ready. Review or edit it before rendering.',
        50,
        'review'
      );

    } else {
      await renderJob(j);
    }

  } catch (error) {
    progress(
      j,
      'Video analysis failed.',
      j.percent,
      'error'
    );

    j.error =
      message(error);

    console.error(
      `[job ${j.id}]`,
      j.error
    );
  }
}

// ==========================================
// REGENERATE SCRIPT
// ==========================================

async function regenerateJob(
  j,
  options
) {
  const oldStatus =
    j.previousStatus || 'review';

  try {
    const regenerated =
      await generateScriptFromContext(
        j.context,

        j.info.duration,

        options,

        j.scriptHistory || [],

        (
          step,
          percent
        ) =>
          progress(
            j,
            step,
            percent,
            'regenerating'
          ),

        j.providerKeys
      );

    j.options =
      options;

    j.script =
      regenerated;

    j.scriptHistory = [
      ...(j.scriptHistory || []),
      structuredClone(regenerated)
    ].slice(-8);

    j.scriptRevision =
      (j.scriptRevision || 1) + 1;

    await writeMetadata(
      j.dir,
      j.script
    );

    j.error = null;

    progress(
      j,
      'A different script is ready. Review and render when happy.',
      50,
      'review'
    );

  } catch (error) {
    j.error =
      message(error);

    progress(
      j,
      'New script failed; your old script is unchanged.',
      50,
      oldStatus === 'done'
        ? 'done'
        : 'review'
    );

    console.error(
      `[job ${j.id}] regenerate:`,
      j.error
    );

  } finally {
    delete j.previousStatus;
  }
}

// ==========================================
// HTTP UPLOADS
// ==========================================

async function receiveUpload(
  req,
  path
) {
  const len = Number(
    req.headers['content-length']
  );

  if (
    Number.isFinite(len) &&
    len > CFG.maxVideoBytes
  ) {
    const error = new Error(
      'Video exceeds upload size limit'
    );

    error.code = 413;

    throw error;
  }

  let size = 0;

  const guard = new Transform({
    transform(
      chunk,
      _encoding,
      callback
    ) {
      size += chunk.length;

      if (
        size > CFG.maxVideoBytes
      ) {
        callback(
          Object.assign(
            new Error('Video too large'),
            { code: 413 }
          )
        );

      } else {
        callback(
          null,
          chunk
        );
      }
    }
  });

  await pipeline(
    req,
    guard,

    createWriteStream(
      path,
      { flags: 'wx' }
    )
  );

  if (size < 2000) {
    throw new Error(
      'Video file is empty or too small'
    );
  }
}

async function readJson(
  req,
  max = 250000
) {
  const chunks = [];

  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > max) {
      throw new Error(
        'JSON request is too large'
      );
    }

    chunks.push(chunk);
  }

  return JSON.parse(
    Buffer.concat(chunks)
      .toString('utf8')
  );
}

// ==========================================
// DOWNLOADS
// ==========================================

async function deliverFile(
  req,
  res,
  j,
  kind,
  forceDownload = false
) {
  const files = {
    video: [
      'final.mp4',
      'video/mp4'
    ],

    captions: [
      'captions.srt',
      'text/plain; charset=utf-8'
    ],

    metadata: [
      'metadata.txt',
      'text/plain; charset=utf-8'
    ],

    script: [
      'script.json',
      'application/json'
    ]
  };

  if (!files[kind]) {
    return json(
      res,
      404,
      {
        error: 'Unknown file type'
      }
    );
  }

  const [name, type] =
    files[kind];

  const extension =
    name.split('.').at(-1);

  const titleName =
    kind === 'video'
      ? safeDownloadName(
          j.script?.metadata?.title
        )
      : `clipcraft-${kind}`;

  const path = join(
    j.dir,
    name
  );

  const fileStat =
    await stat(path);

  const disposition =
    kind === 'video' && !forceDownload
      ? 'inline'
      : 'attachment';

  const headers = {
    'Content-Type': type,

    'Content-Disposition':
      contentDisposition(
        disposition,
        titleName,
        extension
      ),

    'Cache-Control':
      'no-store',

    'X-Content-Type-Options':
      'nosniff'
  };

  // HTML5 video players commonly request byte ranges.
  // Returning 206 + Content-Range prevents blank previews,
  // especially for larger MP4 files served from another origin.
  if (kind === 'video') {
    headers['Accept-Ranges'] =
      'bytes';

    const rangeHeader =
      req.headers.range;

    if (rangeHeader) {
      const range =
        parseByteRange(
          rangeHeader,
          fileStat.size
        );

      if (!range) {
        res.writeHead(
          416,
          {
            'Content-Range':
              `bytes */${fileStat.size}`,

            'Accept-Ranges':
              'bytes',

            'Cache-Control':
              'no-store'
          }
        );

        res.end();
        return;
      }

      const length =
        range.end -
        range.start +
        1;

      res.writeHead(
        206,
        {
          ...headers,

          'Content-Range':
            `bytes ${range.start}-${range.end}/${fileStat.size}`,

          'Content-Length':
            length
        }
      );

      createReadStream(
        path,
        {
          start: range.start,
          end: range.end
        }
      ).pipe(res);

      return;
    }
  }

  res.writeHead(
    200,
    {
      ...headers,

      'Content-Length':
        fileStat.size
    }
  );

  createReadStream(path)
    .pipe(res);
}

// ==========================================
// HTTP API
// ==========================================

const server = http.createServer(
  async (req, res) => {
    cors(req, res);

    if (
      req.method === 'OPTIONS'
    ) {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(
      req.url || '/',
      'http://localhost'
    );

    const path =
      requestUrl.pathname;

    const clientKeys =
      readClientKeys(req);

    try {

      // HEALTH

      if (
        req.method === 'GET' &&
        path === '/api/health'
      ) {
        const ffmpeg = await cmd(
          CFG.ffmpeg,
          ['-version'],
          { timeoutMs: 5000 }
        ).then(
          () => true,
          () => false
        );

        return json(
          res,
          200,
          {
            ok: true,

            ffmpeg,

            geminiConfigured: !!(
              clientKeys.geminiKey ||
              CFG.geminiKey
            ),

            geminiModel:
              CFG.geminiModel,

            geminiModels:
              GEMINI_MODELS,

            cartesiaConfigured: !!(
              clientKeys.cartesiaKey ||
              CFG.cartesiaKey
            ),

            defaultVoice:
              CFG.cartesiaVoice,

            hindiVoice:
              CFG.cartesiaHindiVoice,

            maxDuration:
              CFG.maxDuration,

            maxUploadMB:
              CFG.maxVideoBytes / 1048576
          }
        );
      }

      // VOICES

      if (
        req.method === 'GET' &&
        path === '/api/voices'
      ) {
        return json(
          res,
          200,
          {
            voices:
              await cartesiaVoices(
                clientKeys
              )
          }
        );
      }

      // CREATE JOB

      if (
        req.method === 'POST' &&
        path === '/api/jobs'
      ) {
        if (!hasKeys(clientKeys)) {
          return json(
            res,
            400,
            {
              error:
                'Paste and save Gemini + Cartesia API keys in Settings, or set both keys in backend/.env.'
            }
          );
        }

        const active = [
          ...jobs.values()
        ].filter(
          job =>
            [
              'uploading',
              'analyzing',
              'regenerating',
              'rendering'
            ].includes(job.status)
        ).length;

        if (
          active >= MAX_ACTIVE
        ) {
          return json(
            res,
            429,
            {
              error:
                'Two videos are processing.'
            }
          );
        }

        const mime = String(
          req.headers['content-type'] || ''
        )
          .split(';')[0]
          .trim();

        if (
          ![
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'video/x-matroska'
          ].includes(mime)
        ) {
          return json(
            res,
            415,
            {
              error:
                'Upload MP4, MOV, WebM or MKV'
            }
          );
        }

        let opt;

        try {
          opt = cleanOptions(
            JSON.parse(
              Buffer.from(
                String(
                  req.headers['x-options'] ||
                  ''
                ),
                'base64url'
              ).toString('utf8')
            )
          );

        } catch {
          return json(
            res,
            400,
            {
              error:
                'Invalid upload settings'
            }
          );
        }

        const id =
          randomUUID();

        const dir = join(
          workRoot,
          id
        );

        const j = {
          id,
          dir,
          mime,

          originalPath: join(
            dir,
            'source-upload'
          ),

          options: opt,

          providerKeys:
            clientKeys,

          status: 'uploading',

          step: 'Uploading…',

          percent: 2,

          createdAt:
            Date.now(),

          error: null
        };

        jobs.set(
          id,
          j
        );

        await mkdir(
          dir,
          { recursive: true }
        );

        try {
          await receiveUpload(
            req,
            j.originalPath
          );

        } catch (error) {
          jobs.delete(id);

          await rm(
            dir,
            {
              recursive: true,
              force: true
            }
          );

          throw error;
        }

        progress(
          j,
          'Queued for video analysis',
          5
        );

        json(
          res,
          202,
          externalJob(j)
        );

        void analyzeJob(j);

        return;
      }

      const match =
        /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(render|regenerate|file)(?:\/(video|captions|metadata|script))?)?$/
          .exec(path);

      if (match) {
        const j = jobs.get(
          match[1]
        );

        if (!j) {
          return json(
            res,
            404,
            {
              error:
                'Job not found, possibly expired'
            }
          );
        }

        // JOB STATUS

        if (
          req.method === 'GET' &&
          !match[2]
        ) {
          return json(
            res,
            200,
            externalJob(j)
          );
        }

        // DOWNLOAD

        if (
          req.method === 'GET' &&
          match[2] === 'file' &&
          match[3]
        ) {
          if (
            ![
              'done',
              'review'
            ].includes(j.status)
          ) {
            return json(
              res,
              409,
              {
                error:
                  'File not ready'
              }
            );
          }

          if (
            j.status === 'review' &&
            ![
              'script',
              'metadata'
            ].includes(match[3])
          ) {
            return json(
              res,
              409,
              {
                error:
                  'Video not rendered yet'
              }
            );
          }

          return await deliverFile(
            req,
            res,
            j,
            match[3],
            requestUrl.searchParams.get('download') === '1'
          );
        }

        // REGENERATE SCRIPT

        if (
          req.method === 'POST' &&
          match[2] === 'regenerate'
        ) {
          if (
            ![
              'review',
              'done',
              'error'
            ].includes(j.status) ||
            !j.context ||
            !j.info
          ) {
            return json(
              res,
              409,
              {
                error:
                  'First analyze a video and wait for the script.'
              }
            );
          }

          const active = [
            ...jobs.values()
          ].filter(
            job =>
              [
                'analyzing',
                'regenerating',
                'rendering'
              ].includes(job.status)
          ).length;

          if (
            active >= MAX_ACTIVE
          ) {
            return json(
              res,
              429,
              {
                error:
                  'Server is processing two jobs.'
              }
            );
          }

          const posted =
            await readJson(req);

          const options =
            cleanOptions({
              ...j.options,
              ...(posted.options || {})
            });

          j.providerKeys = {
            ...(j.providerKeys || {}),
            ...clientKeys
          };

          if (
            !GEMINI_MODELS.includes(
              options.geminiModel
            )
          ) {
            return json(
              res,
              400,
              {
                error:
                  'Invalid model'
              }
            );
          }

          j.previousStatus =
            j.status;

          j.error = null;

          progress(
            j,
            'Regenerating a new script using saved video analysis…',
            35,
            'regenerating'
          );

          json(
            res,
            202,
            externalJob(j)
          );

          void regenerateJob(
            j,
            options
          );

          return;
        }

        // RENDER VIDEO

        if (
          req.method === 'POST' &&
          match[2] === 'render'
        ) {
          if (
            ![
              'review',
              'error',
              'done'
            ].includes(j.status) ||
            !j.script ||
            !j.info
          ) {
            return json(
              res,
              409,
              {
                error:
                  'Analyze the video before rendering'
              }
            );
          }

          const posted =
            await readJson(req);

          const mergedOptions =
            cleanOptions({
              ...j.options,
              ...(posted.options || {})
            });

          j.providerKeys = {
            ...(j.providerKeys || {}),
            ...clientKeys
          };

          if (
            mergedOptions.language !==
            j.script.language
          ) {
            return json(
              res,
              409,
              {
                error:
                  'Language changed. Press Regenerate Script first.'
              }
            );
          }

          j.script =
            validateScript(
              posted.script ||
              j.script,

              j.info.duration,

              mergedOptions.language
            );

          j.options =
            mergedOptions;

          j.error = null;

          progress(
            j,
            'Queued for final video render',
            51,
            'rendering'
          );

          json(
            res,
            202,
            externalJob(j)
          );

          void renderJob(j);

          return;
        }
      }

      json(
        res,
        404,
        {
          error: 'Not found'
        }
      );

    } catch (error) {
      if (!res.headersSent) {
        json(
          res,
          error.code === 413
            ? 413
            : 400,

          {
            error:
              message(error)
          }
        );

      } else {
        res.destroy();
      }
    }
  }
);

// ==========================================
// CLEAN OLD JOBS
// ==========================================

const cleaner = setInterval(
  async () => {
    for (
      const [id, j] of jobs
    ) {
      const active = [
        'uploading',
        'analyzing',
        'regenerating',
        'rendering'
      ].includes(j.status);

      const limit =
        j.status === 'done'
          ? CFG.outputTtl
          : CFG.ttl;

      const since =
        j.status === 'done'
          ? (
              j.completedAt ||
              j.createdAt
            )
          : j.createdAt;

      if (
        !active &&
        Date.now() - since > limit
      ) {
        jobs.delete(id);

        await rm(
          j.dir,
          {
            recursive: true,
            force: true
          }
        ).catch(() => {});
      }
    }
  },
  30000
);

cleaner.unref();

server.listen(
  CFG.port,
  () => {
    console.log(
      `ClipCraft API ready: http://localhost:${CFG.port} • ` +
      (
        hasKeys()
          ? 'keys configured'
          : 'configure API keys in .env'
      )
    );
  }
);