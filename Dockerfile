FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    APP_DB_PATH=/data/cues.db \
    APP_PORT=8000

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend

# SQLite 数据目录（挂载卷后数据持久化，容器重建不丢数据）
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

# 启动时自动完成数据库初始化（建表），无需额外步骤
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${APP_PORT:-8000}"]
