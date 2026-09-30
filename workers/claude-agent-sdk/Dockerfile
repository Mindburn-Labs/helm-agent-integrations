FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS sdk
WORKDIR /worker
COPY contract/ts /worker/contract/ts
RUN cd /worker/contract/ts && npm ci && npm run build
COPY claude-agent-sdk /worker/claude-agent-sdk
RUN cd /worker/claude-agent-sdk && npm ci --ignore-scripts && npm run check

FROM python:3.12-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HOME=/tmp
WORKDIR /worker
COPY --from=sdk /usr/local/bin/node /usr/local/bin/node
COPY --from=sdk /worker /worker
COPY contract/python /worker/contract/python
COPY runtime /worker/runtime
RUN pip install --no-cache-dir --require-hashes -r /worker/claude-agent-sdk/requirements.lock && \
    pip install --no-cache-dir --no-deps /worker/contract/python /worker/runtime /worker/claude-agent-sdk
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "helm_claude_worker"]
