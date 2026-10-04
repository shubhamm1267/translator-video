# ClipCraft Adaptive Shorts Pro v3 — AutoFit — Complete Angular + Node.js Project

## v3 FIX — no more 19.9s narration/26.1s video hard failure

- Audio-driven AutoFit measures real Cartesia WAV duration with ffprobe after generation. It does not reject a narration just because its length is below 80% of the video.
- When a 26.1-second Short receives a 19.9-second voice, the backend can automatically call Gemini once to revise the narration using **saved visual evidence**, then call Cartesia once more. No video reupload. The best available take wins.
- Fallback: if Gemini or second TTS request fails, the initial valid voice is retained, gently retimed with FFmpeg, padded where unavoidable, and captions end with speech (they no longer spread across padded silence). Very large mismatches can still leave a quiet outro; no guarantee of perfect fit.
- Fixed music mixing: the narration track is split correctly before Cartesia voice and ducked music are mixed, preventing FFmpeg filter-label reuse.
- There is a maximum of **one extra Gemini text call and one extra Cartesia voice call per render** when AutoFit is needed; these count toward your free quota or provider usage.
- The language-filtered Cartesia voice selection, Regenerate Script button, watermark/opacity, captions switch, CTA effects, title/description/tags all remain.

## What changed

- **EVERY new uploaded video is independently analyzed.** No fixed fish, tea or reference-video scripts are used. Gemini identifies time-ordered actions, topic, exact reveal, uncertainties and (optionally) a dynamic, subject-matched Wikipedia reference for factual context.
- Creative story: specific 0–2s hook → meaningful WHY/HOW or intriguing visible action → escalation → ending grounded in actual footage. Genre-aware (process, montage, demonstration, moment, wildlife, or general), not an artificial always-funny template.
- **Regenerate Script — New Story** after analysis or finishing a video: produces a different hook/script/metadata using cached video understanding. Does NOT upload the video again and does NOT request Cartesia voice; however each regeneration uses Gemini text tokens/requests. Press **Render Edited Video** to make voice and final MP4.
- **Captions enabled by default** for footage WITHOUT existing subtitles; vivid karaoke-like ASS chunk animations, output SRT. Optional “Cover existing subtitles” makes an opaque lower band if original captions are permanently baked into a source (NOT removal or footage reconstruction).
- Separate English-US and Hindi-compatible Cartesia voices, watermark and 0–100% opacity, Like/Subscribe/Bell visual animation, vertical 720×1280 H.264 MP4, Youtube title/description/tags, edit & rerender.
- One continuous Cartesia TTS request rather than multiple disconnected per-scene WAV requests. Synthetic render tests only; creative quality depends on actual footage and provider output.

## Windows setup

Use **Node.js 22.12+**, npm, **FFmpeg and ffprobe** accessible on your PATH, and a Hindi-capable caption font. Windows usually has `Nirmala UI`; Linux/Render should use `Noto Sans Devanagari`. FFmpeg needs `libass` (subtitles filter) and `libx264`. No GPU/database required. Rendering requires a **persistent Node server**, not a 10-second Vercel function.

```powershell
# extract the ZIP, then open PowerShell inside ClipCraft_Adaptive_Shorts_Pro_v3_AutoFit
Copy-Item backend/.env.example backend/.env
notepad backend/.env
# Set GEMINI_API_KEY and CARTESIA_API_KEY in .env
npm install
npm run setup
npm run dev
```

Open http://localhost:4200 and verify API http://localhost:3001/api/health.

## Recommended workflow

1. Upload an MP4/MOV/WebM/MKV, usually 9–30 seconds. Max default 90 sec / 80 MB.
2. Select English US or Hindi, a compatible Cartesia voice and Gemini model. Set captions ON, “Cover existing subtitles” OFF for clean videos. Configure watermark/opacity, CTA, frame fit.
3. Click **Analyze & Review Script First**. Read the proposed story. Click **Regenerate Script — New Story** until the angle is right; each click costs a Gemini text generation, not another video upload, and the old draft is retained when the request fails.
4. You can manually edit narration and metadata. Click **Render Edited Video** to call Cartesia TTS and render with FFmpeg.
5. Download MP4 + optional SRT + title/description/tags publication kit. Re-render when editing after export.

**Generate Complete Short** is also supported: auto-analyze, voice and final output. The script can still be regenerated after rendering; you must render again to update the MP4.

## Technical notes

- Gemini endpoint: Files API + `/v1beta/interactions`, JSON output; fallback on model 404 only. Models available in selector include `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.1-flash-lite`. Actual quotas/model availability can change by key/project; there is no guaranteed unlimited free tier.
- Render deployment: the included root `Dockerfile` installs FFmpeg plus Noto fonts, so Hindi captions do not render as square boxes. If you use Render's native Node runtime instead of Docker, make sure the service has a Devanagari font available and set `CAPTION_FONT_HI` accordingly.
- Optional dynamic research: Wikipedia API. Fact leads are **not verified automatically** and are not authoritative proof; check unusual claims before publishing. No hardcoded facts or reference narration. Unsupported salary/location/hazard claims must not be invented. If Wikipedia is unreachable, the system still writes a visual-grounded script.
- Visual captions have **estimated proportional timestamps** across narration, not word-aligned Cartesia timing. Turn OFF if not wanted. Clean uncaptained input works best.
- Hindi captions need a Devanagari font or they can render as square boxes. Set `CAPTION_FONT_HI=Nirmala UI` on Windows/local, or `CAPTION_FONT_HI=Noto Sans Devanagari` on Linux/Render after installing that font.
- Cartesia `sonic-3.6` is used for one continuous voice. API costs/credits can apply. Keys stay only on backend. Cartesia Voice dropdown lists voice locale support; your account needs compatible voices.
- The optional `backend/assets/background.mp3` can add low-level music (only music you have rights to use). This ZIP does not include copyrighted music.
- Output jobs live in **memory**, temporary job files expire after `JOBS_TTL_MINUTES` (default 120); restart clears the in-memory history. Download videos before expiration. Live Gemini/Cartesia requests require your keys and were **not tested** in this environment.
- **Legal:** Use footage you own/license. Adding narration, subtitles or editing does not remove third-party copyrights. Viral views cannot be guaranteed.

## Tests

```powershell
cd backend
npm test
npm run test:render
npm run test:integration
npm run test:autofit
```

`npm test` verifies script validation, dynamically targeted research and variation prompts. `test:render` creates local FFmpeg fixture with watermark/captions/CTA. `test:autofit` simulates **26.1-second footage with a 19.9-second first Cartesia WAV** and ensures AutoFit leads to a final MP4. `test:integration` mocks Google+Cartesia, submits one video to API, regenerates a different script without second video upload, then generates a full MP4. No API keys are necessary for mock tests.

To build frontend: `cd frontend; npm run build`. It requires npm-installed Angular dependencies. This package is source code, not precompiled `dist`; it intentionally contains no `node_modules` or real credentials.

## File map
- `backend/src/ai.mjs`: Google Gemini analysis, cached creative context, new-script variations, Cartesia voices/TTS
- `backend/src/creative.mjs`: adaptive visual-storytelling prompt and quality checks
- `backend/src/research.mjs`: optional dynamic context (no preset topic)
- `backend/src/server.mjs`: upload, cached job, POST /api/jobs/:id/regenerate, rendering, download
- `backend/src/audio-fit.mjs`: measured audio/video fit decisions, gentle tempo and trailing-caption plan
- `backend/src/media.mjs`: FFmpeg & ASS captions, watermark, overlay, audio mixing
- `frontend/src/app/app.component.ts|html|css`: editor and Regenerate Script UI

Docs: https://ai.google.dev/api/interactions-api | https://docs.cartesia.ai/api-reference/tts/bytes
