"""Local convenience denies. This module makes no gateway authority decision."""

from pathlib import PurePosixPath
import re
import shlex


LINEAR_WRITES = re.compile(r"(?:^|_)(?:create|update|delete|archive|save|write|comment|add)(?:_|$)")
SEPARATORS = frozenset((";", "&&", "||", "|", "&", "(", ")", "\n"))
SHELLS = frozenset(("sh", "bash", "zsh", "dash", "fish"))


def _subcommand(tokens, value_flags):
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in SEPARATORS:
            return None, []
        if token in value_flags:
            i += 2
        elif token.startswith("-"):
            i += 1
        else:
            return token, tokens[i + 1:]
    return None, []


def shell_deny(command, depth=0):
    if not isinstance(command, str) or not command.strip():
        return "Shell command was missing or invalid."
    if depth > 4:
        return "Nested shell command could not be classified."
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return "Shell command could not be classified."
    for index, token in enumerate(tokens):
        executable = PurePosixPath(token).name
        remaining = tokens[index + 1:]
        if executable in ("kubectl", "flux"):
            return "Raw cluster or Flux command is disabled; use an approved HELM gitops merge."
        if executable == "git":
            subcommand, _ = _subcommand(remaining, {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"})
            if subcommand == "push":
                return "Raw git push is disabled; use the HELM gateway git push effect."
        elif executable == "gh":
            subcommand, arguments = _subcommand(remaining, {"-R", "--repo", "--hostname"})
            if subcommand == "pr":
                operation, _ = _subcommand(arguments, {"-R", "--repo"})
                if operation == "merge":
                    return "Raw PR merge is disabled; use the HELM merge effect bound to the head SHA."
        elif executable == "linear":
            if any(LINEAR_WRITES.search(arg.lower()) for arg in remaining if arg not in SEPARATORS):
                return "Raw Linear write is disabled; use HELM Linear effects."
        elif executable in SHELLS:
            for i, arg in enumerate(remaining[:-1]):
                if arg.startswith("-") and "c" in arg[1:]:
                    reason = shell_deny(remaining[i + 1], depth + 1)
                    if reason:
                        return reason
    return None


def tool_deny(event):
    name = event["tool_name"]
    if name in ("Bash", "exec_command", "shell", "shell_command", "local_shell"):
        tool_input = event.get("tool_input")
        return shell_deny(tool_input.get("command") if isinstance(tool_input, dict) else None)
    lowered = name.lower()
    if lowered.startswith("mcp__helm__"):
        return None
    if lowered.startswith("mcp__") and "linear" in lowered and LINEAR_WRITES.search(lowered):
        return "Direct Linear MCP write is disabled; use HELM Linear effects."
    return None
