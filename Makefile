.PHONY: check setup lint test test-js test-python typecheck-python lint-python examples examples-js examples-python samples verify-samples package-js package-python package package-assembly markdown build clean workers-check workers-setup workers-contract-check workers-contract-sync workers-lint workers-test workers-conformance workers-conformance-reference

# The CI gate (.github/workflows/ci.yml runs `make check`).
check: lint test package-assembly markdown workers-check

setup:
	cd packages/python/helm_tool_wrapper && python3 -m pip install --disable-pip-version-check ".[dev]"

lint: setup typecheck-python lint-python

test: setup test-js test-python examples samples verify-samples

test-js:
	cd packages/js/helm-tool-wrapper && npm ci && npm test
	cd packages/js/helm-channel-bridge && npm ci && npm test
	cd packages/opencode-governance && npm ci && npm run typecheck && npm test
	cd packages/js/acp-connector && npm ci && npm test

test-python:
	python3 -m unittest discover packages/python/helm_tool_wrapper/tests

typecheck-python:
	cd packages/python/helm_tool_wrapper && python3 -m mypy --python-version 3.9 helm_tool_wrapper

lint-python:
	cd packages/python/helm_tool_wrapper && python3 -m ruff check helm_tool_wrapper && python3 -m ruff format --check helm_tool_wrapper/examples

examples: examples-js examples-python

examples-js:
	cd packages/js/helm-tool-wrapper && npm run example:framework-helpers

examples-python:
	cd packages/python/helm_tool_wrapper && python3 -m helm_tool_wrapper.examples.framework_helpers

samples:
	python3 scripts/generate_samples.py --check

verify-samples:
	python3 scripts/verify_samples.py

package-js:
	cd packages/js/helm-tool-wrapper && npm ci && npm run build && npm pack --dry-run

package-python:
	cd packages/python/helm_tool_wrapper && python3 -m build && python3 -m twine check dist/*

package: package-js package-python

# The npm tarball and the wheel both carry the framework helper examples.
package-assembly: setup
	bash scripts/check_package_assembly.sh

markdown:
	ruby scripts/check-markdown.rb

build: setup package

clean:
	rm -rf packages/js/helm-tool-wrapper/dist
	rm -rf packages/js/helm-tool-wrapper/node_modules
	rm -rf packages/opencode-governance/dist
	rm -rf packages/opencode-governance/node_modules
	rm -rf packages/js/acp-connector/dist
	rm -rf packages/js/acp-connector/node_modules
	rm -rf packages/python/helm_tool_wrapper/.pytest_cache
	rm -rf packages/python/helm_tool_wrapper/helm_tool_wrapper.egg-info
	rm -rf packages/python/helm_tool_wrapper/build
	rm -rf packages/python/helm_tool_wrapper/dist
	rm -rf workers/contract/ts/dist
	rm -rf workers/contract/ts/node_modules

# ---- workers/ (any-framework agent workers) --------------------------------------------
# workers-check is hermetic (no Docker) and part of `make check`. The Python 3.9 workflow runs
# `lint` and `test-python`, not these: the workers need Python 3.10 or newer.

workers-setup:
	python3 -m pip install --disable-pip-version-check ./workers/contract/python ./workers/conformance

# workers/contract/schema is canonical; the language packages carry byte-identical copies.
workers-contract-check:
	diff -r workers/contract/schema workers/contract/ts/schema
	diff -r workers/contract/schema workers/contract/python/helm_worker_contract/schema

workers-contract-sync:
	rm -f workers/contract/ts/schema/*.json workers/contract/python/helm_worker_contract/schema/*.json
	cp workers/contract/schema/*.json workers/contract/ts/schema/
	cp workers/contract/schema/*.json workers/contract/python/helm_worker_contract/schema/

workers-lint: setup workers-setup
	cd workers/contract/python && python3 -m ruff check . && python3 -m ruff format --check . && python3 -m mypy --python-version 3.10 helm_worker_contract
	cd workers/conformance && python3 -m ruff check . && python3 -m ruff format --check . && MYPYPATH=../contract/python python3 -m mypy --python-version 3.10 helm_worker_conformance

workers-test: workers-setup workers-contract-check
	cd workers/contract/python && python3 -m unittest discover -s tests -t .
	cd workers/contract/ts && npm ci && npm test
	cd workers/conformance && python3 -m unittest discover -s tests -t .

workers-check: workers-lint workers-test

# The kit in Docker mode. Each adapter adds its own workers-conformance-<framework> here.
# The reference worker image is the kit's runner image, so this proves the isolation itself.
workers-conformance-reference:
	cd workers/conformance && PYTHONPATH=. python3 -m helm_worker_conformance --image helm-worker-conformance-runner:local --logs ../../.workers-logs/reference --report ../../.workers-logs/reference/report.json -- python -m helm_worker_conformance.reference_worker

workers-conformance: workers-conformance-reference
