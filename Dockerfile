FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --production && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 8095
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8095/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--max-old-space-size=128", "dist/server.js"]
