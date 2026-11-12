#!/bin/sh
# Entrypoint cho container Railway/Docker.
# Railway mount volume thường thuộc owner root; cấp lại quyền cho appuser
# rồi hạ quyền trước khi chạy Node để SQLite ghi được vào /app/data.
set -e

mkdir -p /app/data
chown -R appuser:appgroup /app/data 2>/dev/null || true
if [ -d /data ]; then
  chown -R appuser:appgroup /data 2>/dev/null || true
fi

exec su-exec appuser:appgroup "$@"
