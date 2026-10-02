// Package the existing source-owned implementations; never maintain an auth or
// transport copy in this plugin's source. Parent qualification builds core first.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {cp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const plugin = join(root, "plugins/openclaw"), output = join(plugin, "dist");
const pins = JSON.parse(await readFile(join(plugin, "source-pins.json"), "utf8"));
const git = (...args) => execFileSync("git", args, {cwd: root, maxBuffer: 4 * 1024 * 1024});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = {};
const sourcePaths = git("ls-tree", "-r", "--name-only", pins.core.commit, pins.core.directory).toString().trim().split("\n");
for (const path of sourcePaths) {
  if (hash(await readFile(join(root, path))) !== hash(git("show", `${pins.core.commit}:${path}`))) {
    throw new Error("Executor core differs from the immutable package source pin: " + path);
  }
  inputs[path] = hash(await readFile(join(root, path)));
}
const boundary = await readFile(join(root, pins.boundary.path));
if (hash(boundary) !== hash(git("show", `${pins.boundary.commit}:${pins.boundary.path}`))) {
  throw new Error("Worker transport boundary differs from its qualified source pin");
}
inputs[pins.boundary.path] = hash(boundary);
const coreDist = join(root, pins.core.directory, "dist");
await readFile(join(coreDist, "index.js"));
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
await cp(coreDist, join(output, "executor"), {recursive: true,
  filter: (source) => !source.includes("/testing/") && !source.endsWith("/testing")
    && !source.includes("test-utils") && !/\.test\.(js|d\.ts)$/.test(source)});
await writeFile(join(output, "boundary.mjs"), boundary);
for (const name of ["config.mjs", "runtime.mjs", "index.mjs"]) {
  const source = await readFile(join(plugin, "src", name), "utf8");
  await writeFile(join(output, name), source
    .replace("../../../executors/core/dist/index.js", "./executor/index.js")
    .replace("../../../workers/openclaw/boundary.mjs", "./boundary.mjs"));
  inputs[`plugins/openclaw/src/${name}`] = hash(source);
}
await cp(join(root, "LICENSE"), join(plugin, "LICENSE"));
const files = {};
async function inventory(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else files[relative(output, path)] = hash(await readFile(path));
  }
}
await inventory(output);
await writeFile(join(output, "source-manifest.json"), JSON.stringify({schema: "helm.openclaw.package-sources/v1",
  pins, inputs, files}, null, 2) + "\n");
console.log("Assembled native plugin from pinned executor core and worker boundary; no publication or runtime proof");
