# The kit's runner image: the stubs, the A2A client and the checks, plus the reference worker
# the kit's own tests use. Build context is workers/:
#   docker build -f workers/conformance/Dockerfile -t helm-worker-conformance workers
FROM python:3.12-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /kit
COPY contract/python /kit/contract
COPY conformance /kit/conformance
RUN pip install --no-cache-dir /kit/contract /kit/conformance
