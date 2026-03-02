FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV CHROME_PROFILE_DIR=/data/.chrome-profile
ENV EXTENSIONS_DIR=/opt/extensions
ENV NOVNC_PORT=6080

# System packages: display stack + dev tools + workspace utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11vnc \
    xdotool \
    scrot \
    wmctrl \
    xclip \
    x11-utils \
    novnc \
    websockify \
    git \
    curl \
    wget \
    vim \
    nano \
    build-essential \
    ca-certificates \
    openssl \
    oathtool \
    unzip \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Playwright + bundled Chromium (NOT system chromium — snap in Ubuntu 24.04)
# Note: Docker image uses Node.js/npm; Bun is only required on the host for Claw'd itself.
# Pinned version for reproducible builds.
# PLAYWRIGHT_BROWSERS_PATH set to shared dir so both root (install) and agent (run) can access.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx -y playwright@1.58.2 install chromium --with-deps \
    && chmod -R a+rX /opt/playwright

# Rename existing ubuntu user (UID 1000) to agent
RUN usermod -l agent ubuntu \
    && usermod -d /home/agent -m agent \
    && groupmod -n agent ubuntu \
    && mkdir -p /workspace /data /opt/extensions /opt/workspace-mcp

# Copy and build MCP server (COPY+build before chown to avoid root-owned artifacts)
COPY packages/workspace-mcp/ /opt/workspace-mcp/
WORKDIR /opt/workspace-mcp
RUN npm ci && npm run build \
    && chown -R agent:agent /workspace /data /opt/extensions /opt/workspace-mcp

# Entrypoint
COPY packages/workspace-mcp/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER agent
WORKDIR /workspace

EXPOSE 3000 6080 5900
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s \
    CMD curl -sf http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
