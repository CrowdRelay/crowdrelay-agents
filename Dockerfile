FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Playwright needs Chromium + system dependencies. Install them in the
# runtime image so the scraper can launch a headless browser at startup.
# This adds ~500MB to the image but is required for Reddit authenticated
# scraping (Reddit blocks unauthenticated JSON API access with a JS
# challenge that only a real browser session can pass).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production && npm cache clean --force
RUN npx playwright install chromium

COPY --from=builder /app/dist ./dist
EXPOSE 8095
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8095/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 & export DISPLAY=:99 && exec node --max-old-space-size=256 dist/server.js"]
