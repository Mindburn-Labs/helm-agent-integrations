FROM python:3.12-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HOME=/tmp
WORKDIR /worker
COPY openai-agents/requirements.lock /worker/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /worker/requirements.lock
COPY contract/python /worker/contract
COPY runtime /worker/runtime
COPY openai-agents /worker/openai-agents
RUN pip install --no-cache-dir --no-deps /worker/contract /worker/runtime /worker/openai-agents
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "helm_openai_worker"]
