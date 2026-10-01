# Node image identity is from the upstream enterprise runtime's pinned source.
# npm engine-strict verifies the actual binary meets OpenClaw's published floor.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS sdk
WORKDIR /worker
COPY contract/ts /worker/contract/ts
RUN cd /worker/contract/ts && npm ci --ignore-scripts && npm run build
COPY openclaw/package.json openclaw/package-lock.json /worker/openclaw/
RUN cd /worker/openclaw && npm ci --ignore-scripts --engine-strict
COPY openclaw/*.mjs /worker/openclaw/
RUN cd /worker/openclaw && npm run check

FROM python:3.12-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HOME=/tmp
WORKDIR /worker
COPY --from=sdk /usr/local/bin/node /usr/local/bin/node
COPY --from=sdk /worker /worker
COPY contract/python /worker/contract/python
COPY runtime /worker/runtime
COPY openclaw/helm_openclaw_worker /worker/openclaw/helm_openclaw_worker
COPY openclaw/pyproject.toml openclaw/requirements.lock /worker/openclaw/
RUN pip install --no-cache-dir --require-hashes -r /worker/openclaw/requirements.lock && \
    pip install --no-cache-dir --no-deps /worker/contract/python /worker/runtime /worker/openclaw
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "helm_openclaw_worker"]
