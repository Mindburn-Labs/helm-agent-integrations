.PHONY: setup lint test validate test-js test-python typecheck-python lint-python examples examples-js examples-python samples verify-samples package-js package-python package build clean

setup:
	cd packages/python/helm_tool_wrapper && python3 -m pip install --disable-pip-version-check ".[dev]"

lint: setup typecheck-python lint-python

test: setup test-js test-python examples samples verify-samples

validate: lint test

test-js:
	cd packages/js/helm-tool-wrapper && npm ci && npm test
	cd packages/js/helm-channel-bridge && npm install && npm test
	cd packages/opencode-governance && npm install && npm test

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
	cd packages/js/helm-tool-wrapper && npm ci && npm pack --dry-run

package-python:
	cd packages/python/helm_tool_wrapper && python3 -m build && python3 -m twine check dist/*

package: package-js package-python

build: setup package

clean:
	rm -rf packages/js/helm-tool-wrapper/dist
	rm -rf packages/js/helm-tool-wrapper/node_modules
	rm -rf packages/opencode-governance/dist
	rm -rf packages/opencode-governance/node_modules
	rm -rf packages/python/helm_tool_wrapper/.pytest_cache
	rm -rf packages/python/helm_tool_wrapper/helm_tool_wrapper.egg-info
	rm -rf packages/python/helm_tool_wrapper/build
	rm -rf packages/python/helm_tool_wrapper/dist
