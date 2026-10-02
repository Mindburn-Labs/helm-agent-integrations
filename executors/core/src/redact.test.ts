import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "./redact.js";
import { fakeSecrets } from "./test-utils.js";

test("redacts every credential shape and keeps the rest of the text", () => {
  const cases: [string, string][] = [
    [`export X=${fakeSecrets.helmAccess}`, "export X=[redacted]"],
    [`refresh ${fakeSecrets.helmRefresh} done`, "refresh [redacted] done"],
    [`key ${fakeSecrets.openai}`, "key [redacted]"],
    [`gh ${fakeSecrets.github} ok`, "gh [redacted] ok"],
    [`pat ${fakeSecrets.githubPat}`, "pat [redacted]"],
    [`aws ${fakeSecrets.aws}`, "aws [redacted]"],
    [`slack ${fakeSecrets.slack}`, "slack [redacted]"],
    [`jwt ${fakeSecrets.jwt}.`, "jwt [redacted]."],
    [`curl -H "Authorization: ${fakeSecrets.bearer}"`, 'curl -H "Authorization: [redacted]"'],
    ["git clone https://user:hunter2pass@example.com/r.git", "git clone https://[redacted]@example.com/r.git"],
    ["TOKEN=abc123 make", "TOKEN=[redacted] make"],
    ['MY_API_KEY="a b c" run', "MY_API_KEY=[redacted] run"],
    ["DB_PASSWORD='x y' run", "DB_PASSWORD=[redacted] run"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("redacts a private key block through its end, or to the end of the text when it is cut off", () => {
  const block = ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join("") + "\nabc\ndef\n" + ["-----END ", "OPENSSH PRIVATE KEY-----"].join("");
  assert.equal(redactSecrets(`before ${block} after`), "before [redacted] after");
  assert.equal(redactSecrets(`before ${block.slice(0, 40)}`), "before [redacted]");
});

test("leaves ordinary commands alone", () => {
  for (const text of ["git status --short", "kubectl get pods -n kube-system", "npm run build", "cat README.md | head", "echo token"]) {
    assert.equal(redactSecrets(text), text);
  }
});
