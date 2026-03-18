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

# Java (11, 17, 21) via Eclipse Adoptium (Temurin) — with retry for transient 502s
RUN mkdir -p /usr/lib/jvm && \
    for v in 11 17 21; do \
      for i in 1 2 3; do \
        curl -fsSL -L --retry 3 --retry-delay 5 \
          "https://api.adoptium.net/v3/binary/latest/${v}/ga/linux/x64/jdk/hotspot/normal/eclipse" \
          | tar xz -C /usr/lib/jvm && break || sleep 10; \
      done; \
    done && \
    ln -sf /usr/lib/jvm/jdk-21* /usr/lib/jvm/java-21-default
# Default to Java 21; agents can switch via JAVA_HOME
ENV JAVA_HOME=/usr/lib/jvm/java-21-default
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Maven
ARG MAVEN_VERSION=3.9.9
RUN curl -fsSL "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
      | tar xz -C /opt && \
    ln -s /opt/apache-maven-${MAVEN_VERSION}/bin/mvn /usr/local/bin/mvn
ENV MAVEN_HOME=/opt/apache-maven-${MAVEN_VERSION}

# Node.js 22 LTS (direct tarball — avoids GPG key setup)
RUN curl -fsSL "https://nodejs.org/download/release/latest-v22.x/node-v22.22.1-linux-x64.tar.xz" \
      | tar xJ -C /usr/local --strip-components=1 && \
    npm install -g npm@latest

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
