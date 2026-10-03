/** Fitting decisions based on real TTS speech duration. No model-dependent WPM guesses. */
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export function audioFitPlan(voiceSeconds, videoSeconds) {
  if (![voiceSeconds, videoSeconds].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('Valid positive voice and video durations are required');
  }
  const targetSeconds = Math.max(0.25, videoSeconds - Math.min(0.45, videoSeconds * 0.025));
  const ratio = voiceSeconds / targetSeconds;
  const needsRewrite = ratio < 0.87 || ratio > 1.16;
  // Preserve energy: never slow the narrator down to fill silence. Severe
  // shortfall is handled by AI rewrite first; small shortfall becomes padding.
  const tempo = ratio > 1 ? clamp(ratio, 1.0, 1.50) : 1.0;
  const speechEnd = Math.min(videoSeconds, voiceSeconds / tempo);
  return {
    needsRewrite,
    ratio: Number(ratio.toFixed(4)),
    targetSeconds,
    tempo,
    speechEnd,
    remainingSeconds: Math.max(0, videoSeconds - speechEnd),
  };
}
