#!/usr/bin/env node
// Process entry point: wires stdio into runCli and exits with its code once the output is flushed.

import { runCli, type Io } from "./main.js";

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

async function readStdin(maxBytes: number): Promise<string | null> {
  // A person running `observe` by hand must not hang on a terminal that never closes.
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const io: Io = {
  stdout: (text) => write(process.stdout, text),
  stderr: (text) => write(process.stderr, text),
  readStdin,
};

const code = await runCli(process.argv.slice(2), process.env, io);
process.exit(code);
