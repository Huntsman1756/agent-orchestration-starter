FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl=3.0.20-1~deb12u2 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global opencode-ai@1.18.15 @openai/codex@0.147.0 \
    && npm cache clean --force

RUN mkdir -p /capsule /broker \
    && chown -R node:node /capsule /broker

COPY --chown=node:node dist/runtime/provider-egress-gateway.js /broker/provider-egress-gateway.js
COPY --chown=node:node dist/runtime/process-sandbox.js /broker/process-sandbox.js
COPY --chown=node:node tests/fixtures/sandbox/hostile-child.mjs /broker/certification/hostile-child.mjs
COPY --chown=node:node tests/fixtures/sandbox/network-probe.mjs /broker/certification/network-probe.mjs

USER node
WORKDIR /capsule
ENTRYPOINT []
