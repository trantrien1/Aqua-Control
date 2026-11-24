# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --prefer-offline
COPY server/ ./server/
COPY public/ ./public/

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
# su-exec để entrypoint hạ quyền sau khi chown volume
RUN apk add --no-cache su-exec \
  && addgroup -S appgroup && adduser -S appuser -G appgroup
# copy chỉ thứ cần thiết từ builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY package.json ./
# thư mục data cho SQLite (volume mount)
RUN mkdir -p data && chown -R appuser:appgroup data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000 1883
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings", "server/index.js"]
