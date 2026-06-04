.PHONY: validate test-js test-python samples verify-samples clean

validate: test-js test-python samples verify-samples

test-js:
	cd packages/js/helm-tool-wrapper && npm test

test-python:
	python3 -m unittest discover packages/python/helm_tool_wrapper/tests

samples:
	python3 scripts/generate_samples.py --check

verify-samples:
	python3 scripts/verify_samples.py

clean:
	rm -rf packages/js/helm-tool-wrapper/dist
	rm -rf packages/js/helm-tool-wrapper/node_modules
	rm -rf packages/python/helm_tool_wrapper/.pytest_cache
	rm -rf packages/python/helm_tool_wrapper/helm_tool_wrapper.egg-info
