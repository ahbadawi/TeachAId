FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# sharp requires libc-compatible binaries — use libc6-compat on Alpine
RUN apk add --no-cache libc6-compat
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY server.ts ./
COPY firebase-applet-config.json ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server.ts"]
