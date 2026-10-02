#!/usr/bin/env node
// Process entry point: wires stdio into runCli and exits with its code once the output is flushed.

import { runCli, type Io } from "./main.js";

// A hook's stdout or stderr reader can be gone by the time we write (a closed pipe). That is an EPIPE error event, which
// would kill the process with exit 1; `observe` must exit 0 whatever happens, so these streams swallow their errors.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

/** All of stdin as text. Null when it is larger than `maxBytes` or does not reach its end within `timeoutMs`. */
function readStdin(maxBytes: number, timeoutMs: number): Promise<string | null> {
  // A person running `observe` by hand must not hang on a terminal that never closes.
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.destroy();
      resolve(value);
    };
    // A producer that holds the pipe open without closing it must not hold this process: the process exits right after.
    const timer = setTimeout(() => finish(null), timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) finish(null);
      else chunks.push(chunk);
    });
    process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => finish(null));
  });
}

const io: Io = {
  stdout: (text) => write(process.stdout, text),
  stderr: (text) => write(process.stderr, text),
  readStdin,
};

const code = await runCli(process.argv.slice(2), process.env, io);
process.exit(code);
