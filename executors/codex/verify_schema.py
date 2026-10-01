"""Validate rendered config against a supplied upstream Codex JSON schema."""

import argparse
import json
from pathlib import Path
import tomllib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--schema", type=Path, required=True)
    args = parser.parse_args()
    import jsonschema

    config = tomllib.loads(args.config.read_text())
    schema = json.loads(args.schema.read_text())
    jsonschema.Draft7Validator(schema).validate(config)
    print("Rendered config matches the supplied schema. Installed-client and QA execution remain separate checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
