# 音律 Mooloco Music — 双架构镜像(amd64/arm64)
# 构建: docker buildx build --platform linux/amd64,linux/arm64 -t mooloco/music-player:1.0.0 --push .
FROM python:3.11-alpine

# ffmpeg:转码/预转/音频解码全部由外部 ffmpeg 子进程完成(server.py 不自行解码)
# tzdata:提供 zoneinfo,配合 TZ=Asia/Shanghai 保证扫描时间戳时区正确
RUN apk add --no-cache ffmpeg tzdata

WORKDIR /app

# .dockerignore 已排除 data/ __pycache__/ transcode/ 等运行产物
COPY . .

RUN pip install --no-cache-dir mutagen \
    && mkdir -p /data /tmp/transcode

# 容器化默认值(全部可被运行时 -e 覆盖;不设 MUSIC_DATA_DIR 时数据落在 /data)
ENV MUSIC_DATA_DIR=/data \
    MUSIC_CACHE_DIR=/tmp/transcode \
    MUSIC_COVER_MEM_MB=128 \
    TZ=Asia/Shanghai

EXPOSE 8090

# 默认以 root 运行(自用可信局域网场景);需要降权时在 compose 用 user: "1000:1000"
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8090/ >/dev/null 2>&1 || exit 1

CMD ["python3", "/app/server.py"]
