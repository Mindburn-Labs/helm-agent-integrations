"""Run the kit against a worker image on an isolated Docker network.

    network (--internal: no route out)
      ├─ runner   stubs + A2A client + egress sinkhole; the worker's DNS server
      └─ worker   the image under test, one fresh container per scenario

Everything created carries the label helm.conformance.run=<id>, and only that is cleaned up.
This module uses only the standard library, so any host with Python 3 and Docker can run it.
"""

from __future__ import annotations

import json
import secrets
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

WORKERS_DIR = Path(__file__).resolve().parents[2]
RUNNER_DOCKERFILE = WORKERS_DIR / "conformance" / "Dockerfile"
MCP_HOST, MODEL_HOST, WORKER_HOST = "mcp.stub.test", "model.stub.test", "worker.stub.test"
WORKER_PORT = 8080
EXTENSION_URI = "urn:helm:a2a:episode:v1"
# The worker runs as it will in the sandbox: no capabilities, no writable root filesystem,
# bounded resources. (Images keep HOME and scratch space under /tmp.)
WORKER_FLAGS = [
    "--read-only",
    "--tmpfs",
    "/tmp:rw,mode=1777,size=512m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "2",
]


class DockerError(RuntimeError):
    pass


def docker(
    *args: str, check: bool = True, timeout: float = 120
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise DockerError(
            f"docker {' '.join(args[:3])} failed ({result.returncode}): {result.stderr.strip()[-600:]}"
        )
    return result


def card_model_apis(card: dict[str, Any]) -> list[str]:
    """The model APIs a worker's AgentCard advertises (kept in step with runner.card_model_apis;
    duplicated because this module must not import the contract package)."""
    for extension in (card.get("capabilities") or {}).get("extensions") or []:
        if extension.get("uri") == EXTENSION_URI:
            apis = (extension.get("params") or {}).get("model_apis")
            return [str(a) for a in apis] if isinstance(apis, list) else []
    return []


@dataclass
class Environment:
    """The network and runner container, created once per kit run."""

    image: str
    run_id: str = field(default_factory=lambda: secrets.token_hex(4))
    network: str = ""
    runner: str = ""
    runner_ip: str = ""

    @property
    def label(self) -> str:
        return f"helm.conformance.run={self.run_id}"

    def setup(self) -> None:
        if not shutil.which("docker"):
            raise DockerError("docker is not on PATH")
        print("building the runner image ...", file=sys.stderr, flush=True)
        runner_image = "helm-worker-conformance-runner:local"
        docker(
            "build",
            "-q",
            "-f",
            str(RUNNER_DOCKERFILE),
            "-t",
            runner_image,
            str(WORKERS_DIR),
            timeout=900,
        )
        self.network = f"helm-cf-{self.run_id}"
        docker("network", "create", "--internal", "--label", self.label, self.network)
        self.runner = f"helm-cf-runner-{self.run_id}"
        docker(
            "run",
            "-d",
            "--name",
            self.runner,
            "--label",
            self.label,
            "--network",
            self.network,
            "--network-alias",
            MCP_HOST,
            "--network-alias",
            MODEL_HOST,
            "--cap-drop",
            "ALL",
            "--cap-add",
            "NET_BIND_SERVICE",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "512m",
            runner_image,
            "sleep",
            "infinity",
        )
        template = f'{{{{(index .NetworkSettings.Networks "{self.network}").IPAddress}}}}'
        self.runner_ip = docker("inspect", "-f", template, self.runner).stdout.strip()
        if not self.runner_ip:
            raise DockerError("the runner container has no address on the internal network")

    def teardown(self) -> None:
        ids = docker("ps", "-aq", "--filter", f"label={self.label}", check=False).stdout.split()
        if ids:
            docker("rm", "-f", *ids, check=False)
        if self.network:
            docker("network", "rm", self.network, check=False)

    def start_worker(
        self, name: str, token: str, ingress: str, command: list[str], extra_env: dict[str, str]
    ) -> str:
        cid = f"helm-cf-worker-{self.run_id}-{name}"
        env = {
            "HELM_EPISODE_TOKEN": token,
            "HELM_A2A_BEARER_TOKEN": ingress,
            "PORT": str(WORKER_PORT),
            **extra_env,
        }
        args = [
            "run",
            "-d",
            "--name",
            cid,
            "--label",
            self.label,
            "--network",
            self.network,
            "--network-alias",
            WORKER_HOST,
            "--dns",
            self.runner_ip,
            *WORKER_FLAGS,
        ]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        docker(*args, self.image, *command)
        return cid

    def stop_worker(self, cid: str) -> tuple[str, int | None]:
        """(the worker's logs, its exit code when it had already exited); the container is removed."""
        state = docker(
            "inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", cid, check=False
        ).stdout.split()
        exited = int(state[1]) if len(state) == 2 and state[0] == "false" else None
        logs = docker("logs", cid, check=False)
        docker("rm", "-f", cid, check=False)
        return logs.stdout + logs.stderr, exited

    def runner_json(self, command: list[str], timeout: float) -> dict[str, Any]:
        try:
            done = docker(
                "exec",
                self.runner,
                "python",
                "-m",
                "helm_worker_conformance.runner",
                *command,
                check=False,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise DockerError(f"the runner did not finish within {timeout:.0f}s") from exc
        lines = [line for line in done.stdout.splitlines() if line.strip()]
        try:
            return json.loads(lines[-1])  # type: ignore[no-any-return]
        except (IndexError, ValueError) as exc:
            raise DockerError(
                f"the runner printed no result (exit {done.returncode}): {done.stderr.strip()[-800:]}"
            ) from exc

    def scenario(self, scenario: str, api: str, token: str, ingress: str) -> dict[str, Any]:
        return self.runner_json(
            [
                "scenario",
                "--id",
                scenario,
                "--api",
                api,
                "--worker-url",
                f"http://{WORKER_HOST}:{WORKER_PORT}",
                "--token",
                token,
                "--ingress-token",
                ingress,
                "--mcp-host",
                MCP_HOST,
                "--model-host",
                MODEL_HOST,
                "--answer-ip",
                self.runner_ip,
            ],
            timeout=420,
        )


def _check(name: str, ok: bool, detail: str = "") -> dict[str, str]:
    return {"name": name, "status": "pass" if ok else "fail", "detail": "" if ok else detail}


def run_image(
    image: str,
    *,
    only: list[str] | None = None,
    apis: list[str] | None = None,
    command: list[str] | None = None,
    extra_env: dict[str, str] | None = None,
    logs_dir: Path | None = None,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    """Run the kit's scenarios against `image`; one result per (scenario, model API)."""
    env = Environment(image)
    results: list[dict[str, Any]] = []
    try:
        env.setup()
        (probe,) = [
            c
            for c in env.runner_json(["isolation"], 60)["checks"]
            if c["name"] == "network_isolated"
        ]
        if probe["status"] != "pass":
            raise DockerError(
                f"the worker network is not isolated ({probe['detail']}); egress checks would prove nothing"
            )
        catalog = env.runner_json(["list"], 60)["scenarios"]
        wanted = [s for s in catalog if not only or s["id"] in only]
        unknown = sorted(set(only or []) - {s["id"] for s in catalog})
        if unknown:
            raise DockerError(f"unknown scenarios: {unknown}")
        card_apis = list(apis or [])

        def run_one(scenario: str, api: str) -> dict[str, Any]:
            token, ingress = f"ept-{secrets.token_hex(12)}", f"ing-{secrets.token_hex(12)}"
            cid = env.start_worker(
                f"{scenario}-{secrets.token_hex(2)}", token, ingress, command or [], extra_env or {}
            )
            try:
                result = env.scenario(scenario, api, token, ingress)
            except DockerError as exc:
                result = {"scenario": scenario, "api": api, "checks": [], "error": str(exc)}
            logs, exited = env.stop_worker(cid)
            if exited is not None:
                result["checks"].append(
                    _check(
                        "worker_stays_up", False, f"the worker container exited with code {exited}"
                    )
                )
            leaked = [
                label
                for label, value in (("episode token", token), ("ingress token", ingress))
                if value in logs
            ]
            result["checks"].append(
                _check(
                    "secrets_not_in_worker_logs",
                    not leaked,
                    f"the worker's log contains the {' and '.join(leaked)}",
                )
            )
            result["worker_log_tail"] = logs.strip().splitlines()[-30:]
            if logs_dir:
                logs_dir.mkdir(parents=True, exist_ok=True)
                (logs_dir / f"{scenario}-{result['api']}.log").write_text(logs)
            results.append(result)
            if progress:
                progress(result)
            return result

        # The card comes first: it says which model APIs the worker speaks.
        first_api = card_apis[0] if card_apis else "anthropic-messages"
        card_result = run_one("agent_card", first_api)
        advertised = card_model_apis(card_result.get("card") or {})
        card_apis = [a for a in (apis or advertised)]
        for a in card_apis:
            if a not in advertised:
                results.append(
                    {
                        "scenario": "agent_card",
                        "api": a,
                        "checks": [
                            _check(
                                "requested_api_is_advertised",
                                False,
                                f"the card advertises {advertised}, not {a}",
                            )
                        ],
                        "error": None,
                    }
                )
        card_apis = [a for a in card_apis if a in advertised] or advertised[:1]
        for scenario in wanted:
            if scenario["id"] == "agent_card":
                continue
            for api in card_apis[:1] if scenario["api_independent"] else card_apis:
                run_one(scenario["id"], api)
    finally:
        env.teardown()
    return results
