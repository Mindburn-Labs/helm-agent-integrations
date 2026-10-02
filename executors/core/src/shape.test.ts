import assert from "node:assert/strict";
import { test } from "node:test";
import { commandShape } from "./shape.js";
import { fakeSecrets } from "./test-utils.js";

test("a command keeps its program and, for action programs, up to two action words", () => {
  const cases: [string, string][] = [
    ["git status --short", "git status"],
    ["git push origin helm/abc", "git push origin"],
    ["gh pr merge 54 --squash --auto", "gh pr merge"],
    ["kubectl get pods -n kube-system", "kubectl get pods"],
    ["flux reconcile kustomization apps", "flux reconcile kustomization"],
    ["npm run build", "npm run build"],
    ["make test-executors", "make test-executors"],
    ["echo conformance-ok", "echo"],
    ["ls -la /etc", "ls"],
    ["/usr/bin/git push", "git push"],
    ["./node_modules/.bin/tsc -p tsconfig.json", "tsc"],
    ["python3 -c 'print(1)'", "python3"],
    ["git commit -m 'a message'", "git commit"],
    ["git -C repo push", "git"],
  ];
  for (const [command, shape] of cases) assert.equal(commandShape(command), shape, command);
});

test("pipelines, lists, subshells and background jobs give one entry per simple command", () => {
  assert.equal(commandShape("cd /tmp && npm test || echo failed; git push &"), "cd; npm test; echo; git push");
  assert.equal(commandShape("cat a.txt | base64 | tee out"), "cat; base64; tee");
  assert.equal(commandShape("(cd x && make) | head"), "cd; make; head");
  assert.equal(commandShape("if true; then rm x; fi"), "true; rm; fi");
  assert.equal(commandShape("! git diff --quiet"), "git diff");
  assert.equal(commandShape("git add . \\\n  && git commit -m x"), "git add; git commit");
});

test("environment assignments, wrappers and redirections do not hide or become the program", () => {
  assert.equal(commandShape("FOO=bar BAZ=qux ./run.sh --flag"), "run.sh");
  assert.equal(commandShape('NAME="a b" make deploy'), "make deploy");
  assert.equal(commandShape("sudo -n kubectl delete pod x"), "kubectl delete pod");
  assert.equal(commandShape("env A=1 gh pr create"), "gh pr create");
  assert.equal(commandShape("time nohup npm test > out.log 2>&1 &"), "npm test");
  assert.equal(commandShape("go test ./... 2>&1 | tail -5"), "go test; tail");
  assert.equal(commandShape("cat < in.txt > out.txt"), "cat");
});

test("quotes, escapes and expansions are opaque, so nothing inside them becomes a program", () => {
  assert.equal(commandShape('echo "a; hunter2 b"'), "echo");
  assert.equal(commandShape("echo 'x && hunter2'"), "echo");
  assert.equal(commandShape("echo $(printf hunter2) done"), "echo");
  assert.equal(commandShape("echo `printf hunter2`; ls"), "echo; ls");
  assert.equal(commandShape("echo ${TOKEN:-hunter2}; ls"), "echo; ls");
  assert.equal(commandShape('"$HOME/bin/tool" --x; ls'), "ls");
  assert.equal(commandShape("echo a\\;hunter2"), "echo");
  assert.equal(commandShape("echo \"unterminated; hunter2"), "echo");
});

test("a here-document ends the scan: its body is data", () => {
  assert.equal(commandShape("cat > .env <<'EOF'\nhunter2 is the password\nTOKEN=hunter2\nEOF\nls"), "cat");
  assert.equal(commandShape("git commit -F - <<EOF\nmessage hunter2\nEOF"), "git commit");
  assert.equal(commandShape("cat <<< hunter2; ls"), "cat; ls");
});

test("no argument value survives: the credential forms a pattern list misses all reduce to a program name", () => {
  const withSecret: [string, string][] = [
    ["mysql -phunter2 -u root db", "hunter2"],
    ["mysql --password=hunter2", "hunter2"],
    ["curl -u admin:hunter2 https://x.example/a", "hunter2"],
    ["curl -H 'x-api-key: hunter2' https://x.example", "hunter2"],
    [`curl -H "PRIVATE-TOKEN: ${fakeSecrets.gitlab}" https://x.example`, fakeSecrets.gitlab],
    [`curl -H "Authorization: ${fakeSecrets.linear}" https://x.example`, fakeSecrets.linear],
    ["sshpass -p hunter2 ssh host", "hunter2"],
    [`stripe charges list --api-key ${fakeSecrets.stripe}`, fakeSecrets.stripe],
    [`npm publish --//registry.npmjs.org/:_authToken=${fakeSecrets.npm}`, fakeSecrets.npm],
    ["aws configure set aws_secret_access_key hunter2hunter2hunter2", "hunter2"],
    [`gcloud auth activate-api-key ${fakeSecrets.google}`, fakeSecrets.google],
    [`huggingface-cli login --token ${fakeSecrets.huggingface}`, fakeSecrets.huggingface],
    ["docker login -u me -p hunter2 registry.example.com", "hunter2"],
    [`vault login ${fakeSecrets.vault}`, fakeSecrets.vault],
    ["openssl enc -aes-256-cbc -k hunter2 -in f", "hunter2"],
    [`printf '%s' ${fakeSecrets.openai} | pbcopy`, fakeSecrets.openai],
    ["MY_PASS=hunter2 ./run.sh", "hunter2"],
    ["export MY_PASS=hunter2", "hunter2"],
    ["git clone https://user:hunter2@github.com/o/r.git", "hunter2"],
    [`git push https://x:${fakeSecrets.github}@github.com/o/r.git`, fakeSecrets.github],
    ["gh auth login --with-token hunter2", "hunter2"],
    ["kubectl create secret generic db --from-literal=password=hunter2", "hunter2"],
    [`echo ${fakeSecrets.helmRefresh} > ~/.config/helm-executor/credentials.json`, fakeSecrets.helmRefresh],
    ["psql postgres://app:hunter2@db.internal/app", "hunter2"],
  ];
  for (const [command, secret] of withSecret) {
    const shape = commandShape(command);
    assert.ok(!shape.includes(secret), `${command} -> ${shape}`);
    assert.ok(shape.length > 0, `${command} -> empty`);
    assert.match(shape, /^[A-Za-z0-9_.~/+ ;-]+$/, command);
  }
});

test("a line with nothing to show gives an empty shape", () => {
  assert.equal(commandShape(""), "");
  assert.equal(commandShape("   \n  "), "");
  assert.equal(commandShape('"$X"'), "");
  assert.equal(commandShape("FOO=bar"), "");
  assert.equal(commandShape(">out"), "");
});

test("fuzz: a secret placed anywhere but in a program or action position never reaches the shape", () => {
  let seed = 20261002;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const pick = <T>(items: T[]): T => items[next(items.length)] as T;
  const S = "S3CR3Tv4lue";
  const programs = ["curl", "echo", "mysql", "ssh", "python3", "psql", "aws", "sshpass", "vault", "docker"];
  const actionPrograms = ["git", "gh", "kubectl", "npm"];
  const args = [
    "-v", "--flag", `-p${S}`, `--token=${S}`, `--password ${S}`, `"${S}"`, `'${S}'`, `"a ${S} b"`, `$(echo ${S})`, `\`echo ${S}\``, `\${TOKEN:-${S}}`,
    `X=${S}`, `https://user:${S}@host/path`, `-H "Authorization: ${S}"`, `>${S}.txt`, `2>/tmp/${S}`, `<<<${S}`, `a\\ ${S}`, `\\${S}`,
  ];
  const operators = [" && ", " || ", "; ", " | ", " &\n", "\n", " ; "];
  const heredocs = [`<<EOF\n${S}\nEOF`, `<<'EOF'\n${S} and more\nEOF`, `<<-EOT\n\t${S}\nEOT`];
  for (let i = 0; i < 4000; i++) {
    const parts: string[] = [];
    const count = 1 + next(4);
    for (let c = 0; c < count; c++) {
      if (next(6) === 0) parts.push(`${pick(["FOO", "TOKEN", "X"])}=${pick([S, `"${S}"`, `'${S}'`])} ${pick(programs)}`);
      else if (next(5) === 0) parts.push(`${pick(["sudo", "env", "time", "nohup"])} ${pick([...programs, ...actionPrograms])}`);
      else parts.push(pick([...programs, ...actionPrograms]));
      // For action programs the first argument must not be the secret in a plain word: that position is an action word.
      const argc = next(5);
      for (let a = 0; a < argc; a++) parts[parts.length - 1] += ` ${pick(args)}`;
      if (next(7) === 0) parts[parts.length - 1] += ` ${pick(heredocs)}`;
      if (c < count - 1) parts.push(pick(operators));
    }
    const command = parts.join("");
    const shape = commandShape(command);
    // The only way a secret word can be a program or an action is by being written bare in that position; none is here,
    // except through an unquoted assignment prefix, which is skipped, or as the word after a wrapper, which these cases never do.
    assert.ok(!shape.includes(S), `${JSON.stringify(command)} -> ${JSON.stringify(shape)}`);
  }
});
