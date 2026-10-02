// The shape of a shell command line: which programs ran, never what they were given.
//
// A command line is where credentials get typed (`mysql -pSECRET`, `curl -u user:pass`, `--token X`, `sshpass -p X`),
// in more forms than any pattern list covers, and an observation summary leaves the machine. So the summary keeps
// each simple command's program and, for programs whose next words name an action (`git push`, `gh pr merge`), up
// to two such words. Every flag, value, URL, path, quoted string and expansion is dropped, and a here-document ends
// the scan, because its body is data.

/** Programs whose first words after the name are an action, like `git push` or `kubectl get pods`. */
const ACTION_PROGRAMS = new Set([
  "git", "gh", "kubectl", "flux", "helm", "docker", "podman", "npm", "npx", "pnpm", "yarn", "go", "cargo", "make",
  "terraform", "tofu", "aws", "gcloud", "az", "doctl", "brew", "systemctl", "launchctl",
]);

/** Words that only prefix the command that follows. */
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "builtin"]);

/** Shell reserved words and group openers that can start a segment. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);

const PROGRAM = /^[A-Za-z0-9_.~/][A-Za-z0-9_.~/+-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9-]{0,30}$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_ONLY = /^\d*(?:[<>]{1,3}|&>|>&|<&)$/;
const REDIRECT = /^\d*(?:[<>]|&>)/;
const MAX_ACTION_WORDS = 2;

interface Word {
  text: string;
  /** True when the word held no quote, escape or expansion, so its text is exactly what the shell sees. */
  plain: boolean;
}

/** Split a command line into segments of words. Quotes and expansions make a word opaque. A here-document stops the scan. */
function segments(command: string): Word[][] {
  const out: Word[][] = [[]];
  let text = "";
  let plain = true;
  let inWord = false;
  let stop = false;

  const endWord = (): void => {
    if (inWord) out[out.length - 1]?.push({ text, plain });
    text = "";
    plain = true;
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if ((out[out.length - 1]?.length ?? 0) > 0) out.push([]);
  };

  for (let i = 0; i < command.length && !stop; i++) {
    const c = command[i] ?? "";
    const next = command[i + 1] ?? "";
    if (c === "'") {
      inWord = true;
      plain = false;
      const close = command.indexOf("'", i + 1);
      i = close === -1 ? command.length : close;
    } else if (c === '"') {
      inWord = true;
      plain = false;
      i += 1;
      while (i < command.length && command[i] !== '"') i += command[i] === "\\" ? 2 : 1;
    } else if (c === "\\" && next === "\n") {
      // A line continuation is whitespace.
      endWord();
      i += 1;
    } else if (c === "\\") {
      inWord = true;
      plain = false;
      i += 1;
    } else if (c === "`") {
      inWord = true;
      plain = false;
      const close = command.indexOf("`", i + 1);
      i = close === -1 ? command.length : close;
    } else if (c === "$") {
      inWord = true;
      plain = false;
      if (next === "(" || next === "{") {
        const open = next;
        const close = open === "(" ? ")" : "}";
        let depth = 0;
        for (i += 1; i < command.length; i++) {
          if (command[i] === open) depth += 1;
          else if (command[i] === close && --depth === 0) break;
        }
      }
    } else if (c === "<" && next === "<") {
      endWord();
      if (command[i + 2] === "<") {
        // A here-string: the word after it is data, and `<<<` is dropped with it like any redirection.
        text = "<<<";
        inWord = true;
        i += 2;
      } else {
        // A here-document: its delimiter and body are data, and what follows the body is not worth the risk.
        stop = true;
      }
    } else if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")") {
      endSegment();
    } else if (c === "&" && command[i - 1] !== ">" && command[i - 1] !== "<" && next !== ">") {
      endSegment();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else {
      inWord = true;
      text += c;
    }
  }
  endWord();
  return out.filter((words) => words.length > 0);
}

function base(program: string): string {
  const name = program.slice(program.lastIndexOf("/") + 1);
  return name === "" ? program : name;
}

function shapeOf(words: Word[]): string | undefined {
  const rest: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as Word;
    if (REDIRECT.test(word.text) && word.plain) {
      if (REDIRECT_ONLY.test(word.text)) i += 1;
      continue;
    }
    rest.push(word);
  }

  let i = 0;
  for (;;) {
    const word = rest[i];
    if (!word) return undefined;
    // `NAME="a b" cmd`: the assignment prefix is unquoted text even when its value is not.
    if (ASSIGNMENT.test(word.text)) {
      i += 1;
    } else if (!word.plain) {
      return undefined;
    } else if (KEYWORDS.has(word.text)) {
      i += 1;
    } else if (WRAPPERS.has(word.text)) {
      i += 1;
      while (rest[i] && (rest[i]?.text.startsWith("-") || ASSIGNMENT.test(rest[i]?.text ?? ""))) i += 1;
    } else {
      break;
    }
  }

  const program = rest[i];
  if (!program || !PROGRAM.test(program.text)) return undefined;
  const name = base(program.text);
  if (!ACTION_PROGRAMS.has(name)) return name;
  const actions: string[] = [];
  for (let j = i + 1; j < rest.length && actions.length < MAX_ACTION_WORDS; j++) {
    const word = rest[j] as Word;
    if (!word.plain || !ACTION.test(word.text)) break;
    actions.push(word.text);
  }
  return [name, ...actions].join(" ");
}

/** The programs and actions of a command line, one `; ` separated entry per simple command. */
export function commandShape(command: string): string {
  return segments(command)
    .map(shapeOf)
    .filter((s): s is string => s !== undefined)
    .join("; ");
}
