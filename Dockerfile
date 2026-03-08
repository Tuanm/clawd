# ---------- Stage 1: Build ----------
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies (includes devDependencies for build tooling)
COPY package.json bun.lock ./
COPY packages/ui/package.json packages/ui/
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
RUN bun install

# Copy source and run full build (UI + embed + compile)
COPY . .
RUN bun run build

# ---------- Stage 2: Runtime ----------
FROM debian:bookworm-slim

# System packages: agent runtime tools + dev essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    bubblewrap \
    ca-certificates \
    curl \
    fd-find \
    ffmpeg \
    findutils \
    git \
    imagemagick \
    jq \
    less \
    openssh-client \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    sed \
    tar \
    tmux \
    unzip \
    wget \
    xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && if [ -f /etc/ImageMagick-6/policy.xml ]; then \
         sed -i 's/rights="none"/rights="read|write"/g' /etc/ImageMagick-6/policy.xml; \
       fi

# cloudflared (tunnel support)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Bun runtime (agents spawn bun for sub-tasks)
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN useradd -m -s /bin/bash clawd \
    && mkdir -p /home/clawd/.clawd/bin \
    && chown -R clawd:clawd /home/clawd

# Rust toolchain (installed as clawd user so cargo lives in ~/.cargo)
USER clawd
ENV RUSTUP_HOME=/home/clawd/.rustup
ENV CARGO_HOME=/home/clawd/.cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
    && rm -rf /home/clawd/.rustup/downloads /home/clawd/.rustup/tmp
ENV PATH="/home/clawd/.cargo/bin:${PATH}"

USER root
COPY --from=builder /app/dist/server/clawd-app /usr/local/bin/clawd-app
RUN ln -s /usr/local/bin/clawd-app /usr/local/bin/clawd

USER clawd
WORKDIR /home/clawd

EXPOSE 3456

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD curl -sf http://localhost:3456/health || exit 1

ENTRYPOINT ["clawd-app"]
CMD ["--no-browser"]
