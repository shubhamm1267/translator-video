FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm ci --prefix backend --omit=dev

COPY backend ./backend

ENV NODE_ENV=production \
  FFMPEG_BIN=ffmpeg \
  FFPROBE_BIN=ffprobe \
  CAPTION_FONT_HI="Noto Sans Devanagari" \
  CAPTION_FONT_EN="DejaVu Sans"

WORKDIR /app/backend
CMD ["npm", "start"]
