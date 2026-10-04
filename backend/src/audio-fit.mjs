
/**
 * ClipCraft Pro — Smart Audio/Video Timing
 *
 * Keeps the narration and footage on one timeline.
 * Plays ALL source footage, with bounded speed-up
 * when voice ends earlier than video.
 */

export const clamp = (number, low, high) =>
  Math.min(high, Math.max(low, number));

const STYLES = Object.freeze({
  clean: {
    minimumVideoRate: 1.00,
    maximumVideoRate: 1.50,
    maximumAudioTempo: 1.26
  },

  dramatic_reveal: {
    minimumVideoRate: 1.00,
    maximumVideoRate: 1.50,
    maximumAudioTempo: 1.26
  },

  viral_funny: {
    minimumVideoRate: 1.04,
    maximumVideoRate: 1.55,
    maximumAudioTempo: 1.28
  },

  fast_explainer: {
    minimumVideoRate: 1.16,
    maximumVideoRate: 1.65,
    maximumAudioTempo: 1.36
  }
});

export function audioFitPlan(
  voiceSeconds,
  videoSeconds,
  style = 'viral_funny'
) {
  if (
    ![voiceSeconds, videoSeconds].every(
      n => Number.isFinite(n) && n > 0
    )
  ) {
    throw new Error(
      'Valid positive voice and video durations are required'
    );
  }

  const config =
    STYLES[style] || STYLES.viral_funny;

  // Leave only a tiny ending breath.
  const endBreath = Math.min(
    0.12,
    videoSeconds * 0.012
  );

  const idealRate =
    videoSeconds /
    Math.max(0.1, voiceSeconds + endBreath);

  const videoRate = clamp(
    Math.max(
      config.minimumVideoRate,
      idealRate
    ),
    config.minimumVideoRate,
    config.maximumVideoRate
  );

  // Complete footage plays in this duration.
  const outputSeconds =
    videoSeconds / videoRate;

  const desiredSpeechSeconds = Math.max(
    0.3,
    outputSeconds - endBreath
  );

  // Pitch-preserving FFmpeg tempo correction.
  const requiredTempo =
    voiceSeconds / desiredSpeechSeconds;

  const tempo = clamp(
    requiredTempo,
    0.88,
    config.maximumAudioTempo
  );

  const speechEnd =
    voiceSeconds / tempo;

  const remainingSeconds = Math.max(
    0,
    outputSeconds - speechEnd
  );

  const excessSeconds = Math.max(
    0,
    speechEnd - outputSeconds
  );

  // Extreme mismatch: request AI rewrite instead
  // of exporting an abruptly cut or silent video.
  const canRender =
    requiredTempo >= 0.875 &&
    requiredTempo <=
      config.maximumAudioTempo + 0.005 &&
    remainingSeconds <= 0.42 &&
    excessSeconds <= 0.20;

  const needsRewrite =
    !canRender ||
    videoRate >= (
      style === 'fast_explainer'
        ? 1.46
        : 1.23
    ) ||
    requiredTempo >= 1.24;

  return {
    ratio: Number(
      (voiceSeconds / videoSeconds).toFixed(4)
    ),

    needsRewrite,
    canRender,

    targetSeconds: outputSeconds,
    outputSeconds,

    videoRate,
    tempo,
    requiredTempo,

    speechEnd: Math.min(
      outputSeconds,
      speechEnd
    ),

    remainingSeconds,
    excessSeconds,

    fastExplainer:
      style === 'fast_explainer'
  };
}
