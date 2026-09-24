#!/usr/bin/env bash
# The twelve framework helper examples must survive packaging: install the npm
# tarball and the Python wheel into clean consumers and run the examples there.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

(
  cd "${repo_root}/packages/js/helm-tool-wrapper"
  npm run build >/dev/null
  npm pack --json --pack-destination "${work}" >"${work}/npm-pack.json"
  node -e 'const pack = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); const files = new Set(pack[0].files.map((file) => file.path)); for (const path of ["dist/framework_helpers_example.js", "dist/framework_helpers_example.d.ts"]) { if (!files.has(path)) throw new Error("missing " + path + " from npm package"); }' "${work}/npm-pack.json"
  tarball="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[0].filename)' "${work}/npm-pack.json")"
  mkdir "${work}/npm-consumer"
  cd "${work}/npm-consumer"
  npm init --yes >/dev/null
  npm install --ignore-scripts --no-audit --no-fund "${work}/${tarball}" >/dev/null
  node --input-type=module -e 'import assert from "node:assert/strict"; import { frameworkHelperExamples, verifyFrameworkHelperExamples, verifyFrameworkHelperPreflightContract } from "@mindburn/helm-tool-wrapper/examples/framework-helpers"; assert.equal(frameworkHelperExamples().length, 12); assert.equal(verifyFrameworkHelperExamples().length, 12); assert.equal((await verifyFrameworkHelperPreflightContract()).length, 12);'
)

(
  cd "${repo_root}/packages/python/helm_tool_wrapper"
  python3 -m build --wheel --outdir "${work}/dist" >/dev/null
  python3 -c 'import glob, sys, zipfile; wheels = glob.glob(sys.argv[1] + "/*.whl"); assert len(wheels) == 1, f"expected one wheel, got {wheels}"; names = set(zipfile.ZipFile(wheels[0]).namelist()); required = {"helm_tool_wrapper/examples/__init__.py", "helm_tool_wrapper/examples/framework_helpers.py"}; missing = required - names; assert not missing, f"missing {missing} from wheel"' "${work}/dist"
  wheel="$(find "${work}/dist" -maxdepth 1 -name '*.whl' -print -quit)"
  python3 -m venv "${work}/venv"
  "${work}/venv/bin/python" -m pip install --quiet --no-index --no-deps "${wheel}"
  "${work}/venv/bin/python" -m helm_tool_wrapper.examples.framework_helpers >/dev/null
)

echo "package assembly: npm tarball and wheel both carry the twelve framework helper examples"
