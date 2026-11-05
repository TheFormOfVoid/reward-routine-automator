# Reward Routine Automator in a container: the Gingerbread extension running
# in a real (headed) Chromium on a virtual display, driven once a day by a
# small Node controller. The build context is the repository root (docker
# compose) or the assembled Home Assistant add-on folder, which has the same
# layout.

# ---- 1. build the extension ----
FROM node:24-bookworm-slim AS extension
WORKDIR /src
COPY src-gingerbread/package.json src-gingerbread/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src-gingerbread/ ./
# The Windows one-click updater is not used in the container.
RUN npm run build && rm -rf dist/updater

# ---- 2. runtime ----
FROM node:24-bookworm-slim

ARG BUILD_ARCH
ARG BUILD_VERSION

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11vnc novnc websockify \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      tini ca-certificates tzdata procps \
 && rm -rf /var/lib/apt/lists/*

COPY --from=extension /src/dist /opt/extension
COPY docker/controller /opt/controller
RUN printf '#!/bin/sh\nexec node /opt/controller/cli.mjs "$@"\n' > /usr/local/bin/rewards \
 && chmod +x /usr/local/bin/rewards

ENV DATA_DIR=/data \
    DISPLAY=:99 \
    CHROMIUM_PATH=/usr/bin/chromium \
    EXTENSION_DIR=/opt/extension \
    WEB_PORT=8099 \
    NODE_ENV=production

VOLUME /data
EXPOSE 8099

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8099)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

LABEL io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}" \
      io.hass.version="${BUILD_VERSION}"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/controller/main.mjs"]
