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
  analyzeVideoEvidence,
  generateScriptFromContext,
  cartesiaVoices,
  speakCartesia,
  validateScript,
  retimeScriptForVoice,
  interactionText,
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

    sourceInfo:
      j.sourceInfo || null,

    selectedClip:
      j.selectedClip || null,

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

function progressRange(
  j,
  from,
  to
) {
  return (
    step,
    percent
  ) => {
    const p =
      Math.max(
        0,
        Math.min(
          50,
          Number(percent) || 0
        )
      ) / 50;

    progress(
      j,
      step,
      Math.max(
        j.percent || 0,
        Math.round(
          from +
          (to - from) * p
        )
      ),
      'analyzing'
    );
  };
}

// ==========================================
// MOVIE SHORTS AUTO-TRIM v5.0
// BEST-CLIP + ENDING-PAYOFF GATE
// ==========================================

const MOVIE_ACTION_RE =
  /(attack|attacks|chase|chases|fight|fights|escape|escapes|run|runs|jump|jumps|fall|falls|crash|crashes|break|breaks|explode|explodes|transform|transforms|open|opens|discover|discovers|find|finds|appear|appears|disappear|disappears|rescue|rescues|save|saves|grab|grabs|bite|bites|hit|hits|shoot|shoots|enter|enters|leave|leaves|reveal|reveals|turn|turns|react|reacts|shock|shocked|danger|monster|shark|giant|trap|trapped|door|secret|power|magic|sudden|suddenly|पीछा|हमला|भाग|गिर|टकर|टूट|फट|बदल|खुल|मिल|दिख|बचा|पकड़|काट|मार|घुस|निकल|खुलासा|चौंक|खतरा|शार्क|राक्षस|जाल|अचानक)/iu;

const MOVIE_PAYOFF_RE =
  /(payoff|result|reveal|reveals|revealed|finally|escape|escapes|escaped|survive|survives|saved|rescue|rescued|defeat|defeats|destroy|destroyed|caught|catches|bite|bites|attack|attacks|crash|crashes|break|breaks|open|opens|discover|discovers|find|finds|appear|appears|reaction|reacts|shocked|turns out|transforms|returns|arrives|ends|final|last|खुलासा|आखिर|अंत|बच|भाग|मिल|पकड़|हमला|काट|टकर|टूट|खुल|चौंक|नतीजा|पता चलता|सामने आ|बदल)/iu;

const MOVIE_WEAK_RE =
  /(empty|nothing happens|open water|only water|just water|dark|darkness|black screen|blank|static shot|still shot|credits|logo|title card|long conversation|talking only|walking only|calm water|blue water|no visible change|खाली|सिर्फ पानी|केवल पानी|अंधेरा|ब्लैक स्क्रीन|क्रेडिट|लोग बस बात|सिर्फ चल|कोई बदलाव नहीं)/iu;

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}

function movieMoments(
  context,
  duration
) {
  const d =
    Math.max(
      1,
      Number(duration) || 1
    );

  return (
    Array.isArray(
      context?.inventory?.moments
    )
      ? context.inventory.moments
      : []
  )
    .map(item => ({
      time:
        Number(item?.time),

      visible:
        String(
          item?.visible || ''
        )
          .replace(/\s+/g, ' ')
          .trim(),

      certainty:
        String(
          item?.certainty || ''
        )
          .trim()
          .toLowerCase()
    }))
    .filter(item =>
      Number.isFinite(item.time) &&
      item.time >= 0 &&
      item.time <= d &&
      item.visible
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

function movieCuts(
  context,
  duration
) {
  const d =
    Math.max(
      1,
      Number(duration) || 1
    );

  return (
    Array.isArray(
      context?.inventory?.sceneCuts
    )
      ? context.inventory.sceneCuts
      : []
  )
    .map(Number)
    .filter(value =>
      Number.isFinite(value) &&
      value > 0.15 &&
      value < d - 0.15
    )
    .sort(
      (a, b) =>
        a - b
    );
}

function snapMovieBoundary(
  value,
  cuts,
  direction = 'nearest',
  radius = 1.5
) {
  const candidates =
    cuts
      .filter(cut =>
        Math.abs(
          cut - value
        ) <= radius
      )
      .filter(cut =>
        direction === 'before'
          ? cut <= value + 0.18
          : direction === 'after'
            ? cut >= value - 0.18
            : true
      )
      .sort(
        (a, b) =>
          Math.abs(
            a - value
          ) -
          Math.abs(
            b - value
          )
      );

  return Number.isFinite(
    candidates[0]
  )
    ? candidates[0]
    : value;
}

function normalizeMovieWindow(
  start,
  end,
  duration,
  cuts = []
) {
  const d =
    Math.max(
      1,
      Number(duration) || 1
    );

  const minLength =
    Math.min(
      28,
      d
    );

  const maxLength =
    Math.min(
      58,
      d
    );

  const idealLength =
    Math.min(
      44,
      d
    );

  let s =
    Number(start);

  let e =
    Number(end);

  if (
    !Number.isFinite(s) ||
    !Number.isFinite(e) ||
    e <= s
  ) {
    s =
      Math.max(
        0,
        d * 0.35
      );

    e =
      Math.min(
        d,
        s + idealLength
      );
  }

  s =
    clamp(
      s,
      0,
      Math.max(
        0,
        d - minLength
      )
    );

  e =
    clamp(
      e,
      s + 0.5,
      d
    );

  if (
    e - s >
    maxLength
  ) {
    e =
      s +
      maxLength;
  }

  if (
    e - s <
    minLength
  ) {
    const center =
      (
        s +
        e
      ) / 2;

    s =
      clamp(
        center -
        idealLength / 2,
        0,
        Math.max(
          0,
          d - idealLength
        )
      );

    e =
      Math.min(
        d,
        s +
        idealLength
      );
  }

  const snappedStart =
    snapMovieBoundary(
      s,
      cuts,
      'before',
      1.6
    );

  const snappedEnd =
    snapMovieBoundary(
      e,
      cuts,
      'after',
      1.6
    );

  if (
    snappedEnd -
      snappedStart >=
      minLength &&
    snappedEnd -
      snappedStart <=
      maxLength
  ) {
    s =
      snappedStart;

    e =
      snappedEnd;
  }

  if (
    e >
    d
  ) {
    e =
      d;

    s =
      Math.max(
        0,
        e -
        idealLength
      );
  }

  if (
    e - s <
    minLength &&
    d >= minLength
  ) {
    e =
      Math.min(
        d,
        s +
        minLength
      );

    s =
      Math.max(
        0,
        e -
        minLength
      );
  }

  return {
    start:
      +s.toFixed(3),

    end:
      +e.toFixed(3),

    duration:
      +(e - s)
        .toFixed(3)
  };
}

function candidateLocalScore(
  candidate,
  moments
) {
  const start =
    candidate.start;

  const end =
    candidate.end;

  const length =
    Math.max(
      1,
      end -
      start
    );

  const inside =
    moments.filter(item =>
      item.time >= start &&
      item.time <= end
    );

  const firstEnd =
    start +
    Math.min(
      8,
      length * 0.24
    );

  const middleStart =
    start +
    length * 0.20;

  const middleEnd =
    start +
    length * 0.76;

  const endingStart =
    end -
    Math.min(
      11,
      length * 0.28
    );

  const first =
    inside.filter(item =>
      item.time <= firstEnd
    );

  const middle =
    inside.filter(item =>
      item.time >= middleStart &&
      item.time <= middleEnd
    );

  const ending =
    inside.filter(item =>
      item.time >= endingStart
    );

  const actionHits =
    inside.filter(item =>
      MOVIE_ACTION_RE.test(
        item.visible
      )
    ).length;

  const openingActionHits =
    first.filter(item =>
      MOVIE_ACTION_RE.test(
        item.visible
      )
    ).length;

  const endingActionHits =
    ending.filter(item =>
      MOVIE_ACTION_RE.test(
        item.visible
      )
    ).length;

  const endingPayoffHits =
    ending.filter(item =>
      MOVIE_PAYOFF_RE.test(
        item.visible
      )
    ).length;

  const weakHits =
    inside.filter(item =>
      MOVIE_WEAK_RE.test(
        item.visible
      )
    ).length;

  const weakEndingHits =
    ending.filter(item =>
      MOVIE_WEAK_RE.test(
        item.visible
      )
    ).length;

  const lastMoment =
    inside.at(-1);

  const lastMomentGap =
    lastMoment
      ? Math.max(
          0,
          end -
          lastMoment.time
        )
      : length;

  const coverage =
    (
      first.length > 0
        ? 1
        : 0
    ) +
    (
      middle.length > 0
        ? 1
        : 0
    ) +
    (
      ending.length > 0
        ? 1
        : 0
    );

  const openingScore =
    clamp(
      first.length * 1.1 +
      openingActionHits * 2.5,
      0,
      10
    );

  const storyScore =
    clamp(
      coverage * 1.7 +
      middle.length * 0.65 +
      actionHits * 0.8,
      0,
      10
    );

  let endingScore =
    ending.length * 1.1 +
    endingActionHits * 1.8 +
    endingPayoffHits * 3.2;

  if (
    lastMomentGap <= 3.5
  ) {
    endingScore += 2.0;
  } else if (
    lastMomentGap <= 6.5
  ) {
    endingScore += 0.8;
  } else {
    endingScore -= 2.5;
  }

  endingScore -=
    weakEndingHits * 2.7;

  endingScore =
    clamp(
      endingScore,
      0,
      10
    );

  const densityScore =
    clamp(
      inside.length * 0.75 +
      actionHits * 0.7,
      0,
      10
    );

  const weakPenalty =
    weakHits * 2.1 +
    weakEndingHits * 2.6;

  const total =
    clamp(
      openingScore * 1.6 +
      storyScore * 2.0 +
      endingScore * 3.1 +
      densityScore * 1.1 -
      weakPenalty,
      0,
      100
    );

  return {
    heuristicScore:
      +total.toFixed(2),

    openingScore:
      +openingScore.toFixed(2),

    storyScore:
      +storyScore.toFixed(2),

    endingScore:
      +endingScore.toFixed(2),

    densityScore:
      +densityScore.toFixed(2),

    momentCount:
      inside.length,

    lastMomentGap:
      +lastMomentGap.toFixed(2),

    endingEvidence:
      ending
        .slice(-3)
        .map(item =>
          `${item.time.toFixed(1)}s ${item.visible}`
        )
        .join(' | ')
        .slice(
          0,
          480
        )
  };
}

function buildMovieCandidates(
  context,
  duration
) {
  const d =
    Math.max(
      1,
      Number(duration) || 1
    );

  const moments =
    movieMoments(
      context,
      d
    );

  const cuts =
    movieCuts(
      context,
      d
    );

  if (
    d <= 62
  ) {
    return [
      {
        ...normalizeMovieWindow(
          0,
          d,
          d,
          cuts
        ),

        ...candidateLocalScore(
          {
            start:
              0,

            end:
              d
          },
          moments
        ),

        source:
          'already-short'
      }
    ];
  }

  const raw = [];

  const add = (
    start,
    end,
    source
  ) => {
    const normalized =
      normalizeMovieWindow(
        start,
        end,
        d,
        cuts
      );

    raw.push({
      ...normalized,
      source
    });
  };

  const lengths =
    [
      32,
      38,
      44,
      50,
      56
    ];

  for (
    const moment
    of moments
  ) {
    for (
      const len
      of lengths
    ) {
      add(
        moment.time -
        3.2,
        moment.time -
        3.2 +
        len,
        'opening-anchor'
      );

      add(
        moment.time +
        4.0 -
        len,
        moment.time +
        4.0,
        'ending-anchor'
      );

      add(
        moment.time -
        len * 0.42,
        moment.time +
        len * 0.58,
        'center-anchor'
      );
    }
  }

  const allCuts =
    [
      0,
      ...cuts,
      d
    ];

  for (
    let i = 0;
    i < allCuts.length;
    i++
  ) {
    const startCut =
      allCuts[i];

    for (
      const target
      of [
        36,
        44,
        52
      ]
    ) {
      const desiredEnd =
        startCut +
        target;

      const endCut =
        allCuts
          .filter(cut =>
            cut >
            startCut +
            27
          )
          .sort(
            (a, b) =>
              Math.abs(
                a -
                desiredEnd
              ) -
              Math.abs(
                b -
                desiredEnd
              )
          )[0];

      if (
        Number.isFinite(
          endCut
        ) &&
        endCut -
          startCut <=
          59
      ) {
        add(
          startCut,
          endCut,
          'cut-to-cut'
        );
      }
    }
  }

  const payoffMoments =
    moments.filter(item =>
      MOVIE_PAYOFF_RE.test(
        item.visible
      )
    );

  for (
    const payoff
    of payoffMoments
  ) {
    const previous =
      moments
        .filter(item =>
          item.time <
            payoff.time -
            18 &&
          item.time >
            payoff.time -
            55
        )
        .filter(item =>
          MOVIE_ACTION_RE.test(
            item.visible
          )
        )
        .at(-1);

    if (previous) {
      add(
        previous.time -
        2.5,
        payoff.time +
        4.5,
        'setup-to-payoff'
      );
    }
  }

  const deduped =
    new Map();

  for (
    const candidate
    of raw
  ) {
    const key =
      `${Math.round(candidate.start * 2) / 2}-` +
      `${Math.round(candidate.end * 2) / 2}`;

    const scored = {
      ...candidate,
      ...candidateLocalScore(
        candidate,
        moments
      )
    };

    const current =
      deduped.get(key);

    if (
      !current ||
      scored.heuristicScore >
      current.heuristicScore
    ) {
      deduped.set(
        key,
        scored
      );
    }
  }

  const sorted =
    [
      ...deduped.values()
    ]
      .filter(candidate =>
        candidate.duration >= 27.5 &&
        candidate.duration <= 58.5
      )
      .sort(
        (a, b) =>
          b.endingScore -
          a.endingScore ||
          b.heuristicScore -
          a.heuristicScore ||
          b.storyScore -
          a.storyScore
      );

  return sorted.slice(
    0,
    12
  );
}

function movieCandidateFallback(
  context,
  duration
) {
  const candidates =
    buildMovieCandidates(
      context,
      duration
    );

  if (
    candidates.length
  ) {
    return candidates;
  }

  const d =
    Math.max(
      1,
      Number(duration) || 1
    );

  const start =
    Math.max(
      0,
      Math.min(
        d - 44,
        d * 0.35
      )
    );

  return [
    {
      ...normalizeMovieWindow(
        start,
        Math.min(
          d,
          start + 44
        ),
        d,
        []
      ),

      heuristicScore:
        0,

      openingScore:
        0,

      storyScore:
        0,

      endingScore:
        0,

      densityScore:
        0,

      momentCount:
        0,

      lastMomentGap:
        44,

      endingEvidence:
        '',

      source:
        'time-fallback'
    }
  ];
}

async function chooseMovieShortCandidates(
  context,
  duration,
  options,
  providerKeys = {}
) {
  const d =
    Number(duration);

  const candidates =
    movieCandidateFallback(
      context,
      d
    );

  if (
    !Number.isFinite(d) ||
    d <= 62 ||
    candidates.length <= 1
  ) {
    return candidates;
  }

  const key =
    providerKeys?.geminiKey ||
    CFG.geminiKey;

  if (!key) {
    return candidates;
  }

  const model =
    GEMINI_MODELS.includes(
      options.geminiModel
    )
      ? options.geminiModel
      : CFG.geminiModel;

  const compactCandidates =
    candidates.map(
      (
        candidate,
        index
      ) => ({
        index,
        start:
          candidate.start,

        end:
          candidate.end,

        duration:
          candidate.duration,

        localOpening:
          candidate.openingScore,

        localStory:
          candidate.storyScore,

        localEnding:
          candidate.endingScore,

        localHeuristic:
          candidate.heuristicScore,

        endingEvidence:
          candidate.endingEvidence
      })
    );

  const prompt = `
You are the FINAL EDITOR choosing the best source clip for a high-retention vertical Movie Short.

SOURCE DURATION:
${d.toFixed(2)} seconds

FULL VISUAL INVENTORY:
${JSON.stringify(
  context?.inventory || {}
).slice(0, 22000)}

CANDIDATE WINDOWS:
${JSON.stringify(compactCandidates)}

Rank the candidates by whether they form a COMPLETE mini-story.

MOST IMPORTANT:
A clip with a weak or empty ending is BAD even if the middle is exciting.

SCORING:
1. OPENING (0-10)
- First 1-4 seconds already contain visible action/question/danger.
- Avoid slow setup before anything happens.

2. MIDDLE (0-10)
- There is a visible change, escalation, chase, discovery, attack,
  transformation, decision, consequence or meaningful reaction.
- Avoid long empty/static/talking-only stretches.

3. ENDING (0-10) — HIGHEST PRIORITY
- Last 3-8 seconds contain a VISIBLE payoff/result/reveal/reaction.
- The selected window must not stop before the event resolves.
- Reject endings that are only empty water, darkness, walking,
  static scenery, credits, or an unresolved setup.

4. STORY (0-10)
- The clip makes sense as:
  HOOK -> SETUP -> ESCALATION -> PAYOFF.
- It should be understandable without scenes outside this window.

5. RETENTION
- Prefer a candidate where a narrator can create an honest open loop
  at the start and satisfy it at the end.
- Do not choose a famous-looking moment just because it contains a shark,
  monster, explosion, etc. The sequence itself must have a satisfying ending.

Use only supplied visual evidence. Do not invent plot facts.

Return the BEST candidates in ranked order.
At least 3 rankings when possible.

JSON ONLY:
{
  "rankings": [
    {
      "index": 0,
      "overallScore": 9.1,
      "openingScore": 8.5,
      "middleScore": 9.0,
      "endingScore": 9.5,
      "storyScore": 9.2,
      "reason": "why this complete mini-story works",
      "hookIdea": "truthful unresolved hook angle",
      "endingEvidence": "exact visible payoff/reaction near the end"
    }
  ]
}
`;

  try {
    const response =
      await fetch(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        {
          method:
            'POST',

          signal:
            AbortSignal.timeout(
              180000
            ),

          headers: {
            'x-goog-api-key':
              key,

            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify({
              model,

              store:
                false,

              input: [
                {
                  type:
                    'text',

                  text:
                    prompt
                }
              ],

              response_format: {
                type:
                  'text',

                mime_type:
                  'application/json',

                schema: {
                  type:
                    'object',

                  properties: {
                    rankings: {
                      type:
                        'array',

                      items: {
                        type:
                          'object',

                        properties: {
                          index: {
                            type:
                              'number'
                          },

                          overallScore: {
                            type:
                              'number'
                          },

                          openingScore: {
                            type:
                              'number'
                          },

                          middleScore: {
                            type:
                              'number'
                          },

                          endingScore: {
                            type:
                              'number'
                          },

                          storyScore: {
                            type:
                              'number'
                          },

                          reason: {
                            type:
                              'string'
                          },

                          hookIdea: {
                            type:
                              'string'
                          },

                          endingEvidence: {
                            type:
                              'string'
                          }
                        },

                        required: [
                          'index',
                          'overallScore',
                          'openingScore',
                          'middleScore',
                          'endingScore',
                          'storyScore',
                          'reason',
                          'hookIdea',
                          'endingEvidence'
                        ]
                      }
                    }
                  },

                  required: [
                    'rankings'
                  ]
                }
              },

              generation_config: {
                temperature:
                  0.08
              }
            })
        }
      );

    if (!response.ok) {
      throw new Error(
        `Movie candidate ranking: ${response.status}`
      );
    }

    const text =
      interactionText(
        await response.json()
      );

    const parsed =
      JSON.parse(
        text.replace(
          /^```json\s*|\s*```$/gi,
          ''
        )
      );

    const rankings =
      Array.isArray(
        parsed?.rankings
      )
        ? parsed.rankings
        : [];

    const byIndex =
      new Map();

    for (
      const rank
      of rankings
    ) {
      const index =
        Math.round(
          Number(rank?.index)
        );

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >=
          candidates.length
      ) {
        continue;
      }

      const base =
        candidates[index];

      const aiOverall =
        clamp(
          Number(rank.overallScore) || 0,
          0,
          10
        );

      const aiOpening =
        clamp(
          Number(rank.openingScore) || 0,
          0,
          10
        );

      const aiMiddle =
        clamp(
          Number(rank.middleScore) || 0,
          0,
          10
        );

      const aiEnding =
        clamp(
          Number(rank.endingScore) || 0,
          0,
          10
        );

      const aiStory =
        clamp(
          Number(rank.storyScore) || 0,
          0,
          10
        );

      let finalScore =
        base.heuristicScore * 0.28 +
        aiOverall * 2.0 +
        aiOpening * 1.2 +
        aiMiddle * 1.5 +
        aiStory * 1.8 +
        aiEnding * 3.8;

      if (
        aiEnding < 6
      ) {
        finalScore -= 22;
      }

      if (
        base.endingScore < 4.5
      ) {
        finalScore -= 12;
      }

      byIndex.set(
        index,
        {
          ...base,

          aiOverall:
            +aiOverall.toFixed(2),

          aiOpening:
            +aiOpening.toFixed(2),

          aiMiddle:
            +aiMiddle.toFixed(2),

          aiEnding:
            +aiEnding.toFixed(2),

          aiStory:
            +aiStory.toFixed(2),

          finalScore:
            +finalScore.toFixed(2),

          reason:
            String(
              rank.reason || ''
            ).slice(
              0,
              420
            ),

          hookIdea:
            String(
              rank.hookIdea || ''
            ).slice(
              0,
              180
            ),

          aiEndingEvidence:
            String(
              rank.endingEvidence || ''
            ).slice(
              0,
              320
            )
        }
      );
    }

    const ranked =
      candidates
        .map(
          (
            candidate,
            index
          ) =>
            byIndex.get(index) ||
            {
              ...candidate,

              aiOverall:
                0,

              aiOpening:
                0,

              aiMiddle:
                0,

              aiEnding:
                0,

              aiStory:
                0,

              finalScore:
                candidate.heuristicScore,

              reason:
                'Local visual scoring fallback.',

              hookIdea:
                '',

              aiEndingEvidence:
                ''
            }
        )
        .sort(
          (a, b) =>
            b.finalScore -
            a.finalScore ||
            b.aiEnding -
            a.aiEnding ||
            b.endingScore -
            a.endingScore
        );

    return ranked.slice(
      0,
      5
    );

  } catch (error) {
    console.warn(
      '[movie best-clip] Gemini ranking unavailable; using local scores:',
      message(error)
    );

    return candidates
      .slice()
      .sort(
        (a, b) =>
          b.endingScore -
          a.endingScore ||
          b.heuristicScore -
          a.heuristicScore
      )
      .slice(
        0,
        5
      );
  }
}

function evaluateMovieClip(
  context,
  duration
) {
  const d =
    Math.max(
      1,
      Number(duration) || 1
    );

  const moments =
    movieMoments(
      context,
      d
    );

  if (
    !moments.length
  ) {
    return {
      pass:
        false,

      overall:
        0,

      opening:
        0,

      middle:
        0,

      ending:
        0,

      reason:
        'No visual moments were found in the trimmed candidate.'
    };
  }

  const opening =
    moments.filter(item =>
      item.time <=
      Math.min(
        8,
        d * 0.24
      )
    );

  const middle =
    moments.filter(item =>
      item.time >=
        d * 0.20 &&
      item.time <=
        d * 0.78
    );

  const ending =
    moments.filter(item =>
      item.time >=
      d -
      Math.min(
        10,
        d * 0.28
      )
    );

  const actionCount =
    list =>
      list.filter(item =>
        MOVIE_ACTION_RE.test(
          item.visible
        )
      ).length;

  const payoffCount =
    list =>
      list.filter(item =>
        MOVIE_PAYOFF_RE.test(
          item.visible
        )
      ).length;

  const weakCount =
    list =>
      list.filter(item =>
        MOVIE_WEAK_RE.test(
          item.visible
        )
      ).length;

  const openingScore =
    clamp(
      opening.length * 1.3 +
      actionCount(opening) * 2.4,
      0,
      10
    );

  const middleScore =
    clamp(
      middle.length * 0.9 +
      actionCount(middle) * 1.4,
      0,
      10
    );

  const last =
    moments.at(-1);

  const lastGap =
    Math.max(
      0,
      d -
      last.time
    );

  let endingScore =
    ending.length * 1.2 +
    actionCount(ending) * 1.8 +
    payoffCount(ending) * 3.0 -
    weakCount(ending) * 3.0;

  if (
    lastGap <= 3.5
  ) {
    endingScore += 2.2;
  } else if (
    lastGap <= 6.0
  ) {
    endingScore += 0.7;
  } else {
    endingScore -= 2.8;
  }

  endingScore =
    clamp(
      endingScore,
      0,
      10
    );

  const phaseCoverage =
    (
      opening.length
        ? 1
        : 0
    ) +
    (
      middle.length
        ? 1
        : 0
    ) +
    (
      ending.length
        ? 1
        : 0
    );

  const storyScore =
    clamp(
      phaseCoverage * 2.0 +
      Math.min(
        4,
        moments.length * 0.45
      ) +
      Math.min(
        2,
        payoffCount(ending) * 1.2
      ),
      0,
      10
    );

  const overall =
    clamp(
      openingScore * 0.20 +
      middleScore * 0.20 +
      storyScore * 0.20 +
      endingScore * 0.40,
      0,
      10
    );

  const pass =
    moments.length >= 5 &&
    openingScore >= 4.5 &&
    middleScore >= 4.5 &&
    endingScore >= 6.0 &&
    storyScore >= 5.2 &&
    overall >= 5.8 &&
    lastGap <= 7.0;

  const reason =
    pass
      ? (
          `Passed clip quality gate: opening ${openingScore.toFixed(1)}/10, ` +
          `middle ${middleScore.toFixed(1)}/10, ending ${endingScore.toFixed(1)}/10.`
        )
      : (
          `Rejected/weak candidate: opening ${openingScore.toFixed(1)}/10, ` +
          `middle ${middleScore.toFixed(1)}/10, ending ${endingScore.toFixed(1)}/10, ` +
          `last visible event ${lastGap.toFixed(1)}s before clip end.`
        );

  return {
    pass,

    overall:
      +overall.toFixed(2),

    opening:
      +openingScore.toFixed(2),

    middle:
      +middleScore.toFixed(2),

    ending:
      +endingScore.toFixed(2),

    story:
      +storyScore.toFixed(2),

    momentCount:
      moments.length,

    lastMomentGap:
      +lastGap.toFixed(2),

    endingEvidence:
      ending
        .slice(-4)
        .map(item =>
          `${item.time.toFixed(1)}s ${item.visible}`
        )
        .join(' | ')
        .slice(
          0,
          560
        ),

    reason
  };
}

async function trimMovieShort(
  input,
  output,
  selection
) {
  const start =
    Math.max(
      0,
      Number(
        selection.start
      ) || 0
    );

  const duration =
    Math.max(
      1,
      Number(
        selection.end
      ) -
      start
    );

  await cmd(
    CFG.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',

      '-ss',
      start.toFixed(3),

      '-i',
      input,

      '-t',
      duration.toFixed(3),

      '-map',
      '0:v:0',

      '-map',
      '0:a:0?',

      '-c:v',
      'libx264',

      '-preset',
      'veryfast',

      '-crf',
      '20',

      '-pix_fmt',
      'yuv420p',

      '-c:a',
      'aac',

      '-b:a',
      '160k',

      '-avoid_negative_ts',
      'make_zero',

      '-movflags',
      '+faststart',

      output
    ],
    {
      timeoutMs:
        Math.max(
          180000,
          Math.min(
            900000,
            Math.round(
              duration *
              9000
            )
          )
        )
    }
  );

  return output;
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

    const normalizedInput =
      await inputToMp4(
        j,
        j.originalPath,
        j.mime
      );

    j.inputPath =
      normalizedInput;

    j.sourceInfo =
      await probe(
        normalizedInput
      );

    j.info =
      j.sourceInfo;

    const movieMode =
      j.options.voiceStyle ===
      'fast_explainer';

    const shouldTrim =
      movieMode &&
      j.sourceInfo.duration > 62;

    let first;

    if (shouldTrim) {
      progress(
        j,
        'Scanning the full video for multiple strong Short candidates…',
        10,
        'analyzing'
      );

      const scout =
        await analyzeVideoEvidence(
          normalizedInput,
          j.sourceInfo.duration,
          j.options,

          progressRange(
            j,
            10,
            25
          ),

          j.providerKeys
        );

      progress(
        j,
        'Ranking clips by hook, action and visible ending payoff…',
        27,
        'analyzing'
      );

      const rankedCandidates =
        await chooseMovieShortCandidates(
          scout.context,
          j.sourceInfo.duration,
          j.options,
          j.providerKeys
        );

      if (!rankedCandidates.length) {
        throw new Error(
          'Could not find a usable Movie Shorts candidate in this video.'
        );
      }

      const maxChecks =
        Math.min(
          3,
          rankedCandidates.length
        );

      const attempts = [];

      for (
        let index = 0;
        index < maxChecks;
        index++
      ) {
        const candidate =
          rankedCandidates[index];

        progress(
          j,
          `Testing candidate ${index + 1}/${maxChecks}: ` +
          `${candidate.start.toFixed(1)}s-${candidate.end.toFixed(1)}s…`,
          30 + index * 5,
          'analyzing'
        );

        const candidatePath =
          join(
            j.dir,
            `movie-candidate-${index + 1}.mp4`
          );

        await trimMovieShort(
          normalizedInput,
          candidatePath,
          candidate
        );

        const candidateInfo =
          await probe(
            candidatePath
          );

        const evidence =
          await analyzeVideoEvidence(
            candidatePath,
            candidateInfo.duration,
            j.options,

            progressRange(
              j,
              31 + index * 5,
              35 + index * 5
            ),

            j.providerKeys
          );

        const quality =
          evaluateMovieClip(
            evidence.context,
            candidateInfo.duration
          );

        attempts.push({
          candidate,
          path:
            candidatePath,
          info:
            candidateInfo,
          context:
            evidence.context,
          quality,
          rank:
            index + 1
        });

        if (quality.pass) {
          break;
        }

        if (
          index <
          maxChecks - 1
        ) {
          progress(
            j,
            `Candidate ${index + 1} had a weak ending; checking the next one…`,
            35 + index * 5,
            'analyzing'
          );
        }
      }

      const passing =
        attempts.find(
          item =>
            item.quality.pass
        );

      const winner =
        passing ||
        attempts
          .slice()
          .sort(
            (a, b) =>
              b.quality.overall -
              a.quality.overall ||
              b.quality.ending -
              a.quality.ending ||
              (
                Number(
                  b.candidate.finalScore
                ) || 0
              ) -
              (
                Number(
                  a.candidate.finalScore
                ) || 0
              )
          )[0];

      if (!winner) {
        throw new Error(
          'Movie clip quality validation failed.'
        );
      }

      j.inputPath =
        winner.path;

      j.info =
        winner.info;

      j.context =
        winner.context;

      j.selectedClip = {
        ...winner.candidate,

        sourceDuration:
          +j.sourceInfo.duration
            .toFixed(3),

        candidateRank:
          winner.rank,

        qualityGate:
          winner.quality,

        testedCandidates:
          attempts.map(item => ({
            rank:
              item.rank,

            start:
              item.candidate.start,

            end:
              item.candidate.end,

            rankingScore:
              item.candidate.finalScore ??
              item.candidate.heuristicScore,

            quality:
              item.quality
          }))
      };

      progress(
        j,
        `Best clip locked: ${j.selectedClip.start.toFixed(1)}s-` +
        `${j.selectedClip.end.toFixed(1)}s · ending ` +
        `${winner.quality.ending.toFixed(1)}/10. Writing final narration…`,
        46,
        'analyzing'
      );

      const script =
        await generateScriptFromContext(
          j.context,
          j.info.duration,
          j.options,
          [],
          (
            step,
            percent
          ) =>
            progress(
              j,
              step,
              Math.max(
                46,
                Math.min(
                  49,
                  Math.round(
                    46 +
                    (
                      Math.max(
                        0,
                        Math.min(
                          50,
                          Number(percent) || 0
                        )
                      ) /
                      50
                    ) *
                    3
                  )
                )
              ),
              'analyzing'
            ),
          j.providerKeys
        );

      first = {
        context:
          j.context,

        script
      };

    } else {
      j.selectedClip = {
        start:
          0,

        end:
          +j.sourceInfo.duration
            .toFixed(3),

        duration:
          +j.sourceInfo.duration
            .toFixed(3),

        sourceDuration:
          +j.sourceInfo.duration
            .toFixed(3),

        reason:
          movieMode
            ? 'Source is already Short-sized, so no trim was needed.'
            : 'Auto-trim is enabled only for Movie Shorts mode.',

        hookIdea:
          ''
      };

      progress(
        j,
        'Uploading to Google Gemini Files API…',
        12
      );

      first =
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
              percent,
              'analyzing'
            ),

          j.providerKeys
        );
    }

    j.script =
      first.script;

    j.context =
      first.context;

    j.scriptHistory = [
      structuredClone(
        first.script
      )
    ];

    j.scriptRevision =
      1;

    await writeMetadata(
      j.dir,
      j.script
    );

    if (j.options.review) {
      progress(
        j,
        shouldTrim
          ? `Auto-selected ${j.info.duration.toFixed(1)}s clip. Script ready for review.`
          : 'Script ready. Review or edit it before rendering.',
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