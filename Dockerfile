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
    git \
    jq \
    openssh-client \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    tmux \
    unzip \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

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
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default
ENV PATH="/home/clawd/.cargo/bin:${PATH}"

USER root
COPY --from=builder /app/dist/server/clawd-app /usr/local/bin/clawd-app

USER clawd
WORKDIR /home/clawd

EXPOSE 3456

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD curl -sf http://localhost:3456/health || exit 1

ENTRYPOINT ["clawd-app"]
CMD ["--no-browser"]
