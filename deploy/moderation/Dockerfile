# The moderation job as a CPU-only container (docs/specs/moderation-v1.md §4.1). Built from the
# repository root (compose.yml sets the context); only tools/moderation is copied in. The models
# are not baked in: the first run fetches them into the /models volume, each file SHA-256 checked
# against tools/moderation/policy.yaml.

FROM ghcr.io/astral-sh/uv:0.12.21 AS uv

# A small ffmpeg/ffprobe: every built-in demuxer and decoder (so any file ffmpeg reads still
# decodes), but no external libraries, no encoders or muxers beyond raw float PCM, no network, no
# devices, no video scaling. About 30 MB instead of the ~450 MB the distribution package pulls in.
FROM python:3.12-slim-trixie AS ffmpeg
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential nasm curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xf ffmpeg.tar.xz --strip-components=1 \
    && ./configure \
        --prefix=/opt/ffmpeg \
        --disable-autodetect --disable-doc --disable-debug --disable-network \
        --disable-ffplay --disable-avdevice --disable-swscale --disable-hwaccels \
        --disable-encoders --enable-encoder=pcm_f32le \
        --disable-muxers --enable-muxer=pcm_f32le \
        --disable-protocols --enable-protocol=file,pipe \
        --disable-filters --enable-filter=abuffer,abuffersink,aformat,anull,aresample,atrim \
    && make -j"$(nproc)" \
    && make install \
    && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe

FROM python:3.12-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
# Dependencies only (cached layer); run.py imports the package from /app directly. faster-whisper
# (CTranslate2, ONNX Runtime) and LiteRT come as CPU wheels; nothing pulls in torch or CUDA.
COPY tools/moderation/pyproject.toml tools/moderation/uv.lock ./
RUN uv sync --frozen --no-dev --group models --no-install-project
COPY tools/moderation/ ./

FROM python:3.12-slim-trixie
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin moderation \
    && mkdir /models && chown moderation:moderation /models
COPY --from=build /app /app
COPY deploy/moderation/run.sh /app/run.sh
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODERATION_CACHE=/models \
    ORT_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_OFFLINE=1
USER moderation
WORKDIR /app
VOLUME ["/models"]
ENTRYPOINT ["/app/run.sh"]
