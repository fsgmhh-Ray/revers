FROM node:22-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

# yt-dlp + ffmpeg（ffmpeg 用于后续 Stage2 的关键帧抽取）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl \
 && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV PORT=9000
EXPOSE 9000

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9000/health || exit 1

CMD ["node", "src/server.js"]
