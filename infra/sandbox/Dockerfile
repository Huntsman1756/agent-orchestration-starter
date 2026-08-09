FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN npm install --global opencode-ai@1.18.15 @openai/codex@0.147.0 \
    && npm cache clean --force

RUN mkdir -p /capsule /broker \
    && chown -R node:node /capsule /broker

COPY --chown=node:node dist/runtime/provider-egress-gateway.js /broker/provider-egress-gateway.js

USER node
WORKDIR /capsule
ENTRYPOINT []
