# Release Process

This repository publishes source, generated samples, and local package archives
through GitHub Releases first.

Registry publication is a separate step:

- npm package: `@mindburn/helm-tool-wrapper`
- Python package: `helm-tool-wrapper`

Do not publish packages to npm or PyPI unless authenticated with the official
Mindburn Labs publisher identity.

## Validate

```bash
make clean
make validate
make package
```

## GitHub Release

```bash
git tag -a v0.1.0 -m "helm-agent-integrations v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 \
  --title "helm-agent-integrations v0.1.0" \
  --notes-file /tmp/helm-agent-integrations-v0.1.0-notes.md
```

Attach package archives only after `make package` passes.

