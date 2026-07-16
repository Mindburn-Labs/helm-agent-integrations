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
python3 -m pip install "packages/python/helm_tool_wrapper[dev]"
make clean
make validate
make package
```

The Python release tools are exact-pinned in the package's `dev` extra; the
TypeScript commands use the committed lockfile through `npm ci`.

## GitHub Release

```bash
VERSION=vX.Y.Z
git tag -a "$VERSION" -m "helm-agent-integrations $VERSION"
git push origin "$VERSION"
gh release create "$VERSION" \
  --title "helm-agent-integrations $VERSION" \
  --notes-file "/tmp/helm-agent-integrations-$VERSION-notes.md"
```

Attach package archives only after `make package` passes.
