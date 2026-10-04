
FROM node:22-bookworm-slim

# FFmpeg, Hindi fonts and English fonts
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       fontconfig \
       fonts-noto-core \
       fonts-dejavu-core \
       ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for Docker caching
COPY package*.json ./
COPY backend/package*.json ./backend/

# Install backend production dependencies
RUN npm ci --prefix backend --omit=dev

# Copy backend source
COPY backend ./backend

ENV NODE_ENV=production \
    FFMPEG_BIN=ffmpeg \
    FFPROBE_BIN=ffprobe \
    CAPTION_FONT_HI="Noto Sans Devanagari" \
    CAPTION_FONT_EN="DejaVu Sans"

WORKDIR /app/backend

# Documentation of the listening port
EXPOSE 10000

CMD ["npm", "start"]
