# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --prefer-offline
COPY server/ ./server/
COPY public/ ./public/
COPY tools/ ./tools/

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
# user non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# copy chỉ thứ cần thiết từ builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/tools ./tools
COPY package.json ./
# thư mục data cho SQLite (volume mount)
RUN mkdir -p data && chown -R appuser:appgroup data
USER appuser
ENV NODE_ENV=production
EXPOSE 3000 1883
CMD ["node", "--no-warnings", "server/index.js"]