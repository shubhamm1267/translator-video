import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env reader: no third-party libraries required.
try {
  const content = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let v = match[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[match[1]] = v;
  }
} catch (e) { if (e.code !== 'ENOENT') console.warn('Unable to read .env:', e.message); }

export const CFG = {
  port: Number(process.env.PORT || 3001),
  origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  cartesiaKey: process.env.CARTESIA_API_KEY || '',
  cartesiaModel: process.env.CARTESIA_MODEL || 'sonic-3.6',
  cartesiaVersion: process.env.CARTESIA_VERSION || '2026-08-14',
  cartesiaVoice: process.env.CARTESIA_DEFAULT_VOICE || 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
  cartesiaHindiVoice: process.env.CARTESIA_HINDI_VOICE || 'a0e99841-438c-4a64-b679-ae501e7d6091',
  cartesiaSpeed: Math.min(1.5, Math.max(0.6, Number(process.env.CARTESIA_SPEED || 1.16))),
  cartesiaVolume: Math.min(2, Math.max(0.5, Number(process.env.CARTESIA_VOLUME || 1.25))),
  cartesiaEmotion: process.env.CARTESIA_EMOTION || 'excited',
  maxVideoBytes: Math.min(300, Math.max(1, Number(process.env.MAX_VIDEO_MB || 80))) * 1024 * 1024,
  maxDuration: Math.min(600, Math.max(5, Number(process.env.MAX_DURATION_SECONDS || 90))),
  ttl: Math.max(5, Number(process.env.JOBS_TTL_MINUTES || 30)) * 60 * 1000,
  outputTtl: Math.max(1, Number(process.env.OUTPUT_TTL_MINUTES || 10)) * 60 * 1000,
  purgeWorkOnStart: process.env.PURGE_WORK_ON_START !== 'false',
  ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
};
