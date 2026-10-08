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
    maximumVideoRate: 1.90,
    minimumAudioTempo: 0.70,
    maximumAudioTempo: 1.26
  },

  dramatic_reveal: {
    minimumVideoRate: 1.00,
    maximumVideoRate: 1.90,
    minimumAudioTempo: 0.70,
    maximumAudioTempo: 1.26
  },

  viral_funny: {
    // Multi-character Comedy normally bypasses global fitting because its
    // dialogue renderer is timeline-synced. Keep the legacy fallback here
    // for single-voice/fallback cases and backward-compatible tests.
    minimumVideoRate: 1.04,
    maximumVideoRate: 2.25,
    minimumAudioTempo: 0.68,
    maximumAudioTempo: 1.28
  },

  facts_explainer: {
    minimumVideoRate: 1.10,
    maximumVideoRate: 2.25,
    minimumAudioTempo: 0.68,
    maximumAudioTempo: 1.32
  },

  story_narrator: {
    minimumVideoRate: 1.02,
    maximumVideoRate: 2.05,
    minimumAudioTempo: 0.70,
    maximumAudioTempo: 1.28
  },

  fast_explainer: {
    // Movie Shorts v5.1: preserve the selected story clip.
    // A 35s winner must never become a 15s export simply
    // because narration is short.
    minimumVideoRate: 1.00,
    maximumVideoRate: 1.02,
    minimumAudioTempo: 0.92,
    maximumAudioTempo: 1.14
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

  const endBreath = Math.min(
    0.12,
    videoSeconds * 0.012
  );

  const idealRate =
    videoSeconds /
    Math.max(
      0.1,
      voiceSeconds + endBreath
    );

  const videoRate = clamp(
    Math.max(
      config.minimumVideoRate,
      idealRate
    ),
    config.minimumVideoRate,
    config.maximumVideoRate
  );

  const outputSeconds =
    videoSeconds / videoRate;

  const desiredSpeechSeconds =
    Math.max(
      0.3,
      outputSeconds - endBreath
    );

  const requiredTempo =
    voiceSeconds /
    desiredSpeechSeconds;

  const tempo = clamp(
    requiredTempo,
    config.minimumAudioTempo,
    config.maximumAudioTempo
  );

  const speechEnd =
    voiceSeconds / tempo;

  const remainingSeconds =
    Math.max(
      0,
      outputSeconds - speechEnd
    );

  const excessSeconds =
    Math.max(
      0,
      speechEnd - outputSeconds
    );

  const canRender =
    requiredTempo >=
      config.minimumAudioTempo - 0.005 &&
    requiredTempo <=
      config.maximumAudioTempo + 0.005 &&
    remainingSeconds <= 0.55 &&
    excessSeconds <= 0.20;

  const needsRewrite =
    !canRender ||
    videoRate >= (
      style === 'fast_explainer'
        ? 1.015
        : style === 'facts_explainer'
          ? 1.36
          : style === 'story_narrator'
            ? 1.30
            : 1.23
    ) ||
    requiredTempo >= (
      style === 'fast_explainer'
        ? 1.12
        : 1.24
    );

  return {
    ratio: Number(
      (
        voiceSeconds /
        videoSeconds
      ).toFixed(4)
    ),

    needsRewrite,
    canRender,

    targetSeconds:
      outputSeconds,

    outputSeconds,

    videoRate,
    tempo,
    requiredTempo,

    speechEnd:
      Math.min(
        outputSeconds,
        speechEnd
      ),

    remainingSeconds,
    excessSeconds,

    emergencySlowdown:
      requiredTempo < 0.875,

    fastExplainer:
      style === 'fast_explainer' ||
      style === 'facts_explainer' ||
      style === 'story_narrator'
  };
}