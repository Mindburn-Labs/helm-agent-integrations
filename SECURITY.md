# Security Policy

Report vulnerabilities privately through GitHub Security Advisories for this
repository or email `oss@mindburn.org`.

Do not include secrets, customer data, private repository contents, production
credentials, or regulated records in an issue, pull request, discussion, or
public demo.

## Scope

This repository contains HELM-compatible adapters, examples, sample receipts,
and sample EvidencePacks. It does not define HELM conformance or HELM kernel
security semantics. Kernel security issues belong in
`Mindburn-Labs/helm-ai-kernel`.

## Supported Surface

- TypeScript and Python wrapper source in `packages/`
- generated sample receipt and EvidencePack scripts
- GitHub Actions validation
- documentation that could mislead users into unsafe dispatch behavior

## Out Of Scope

- upstream framework vulnerabilities
- social-media impersonation or unsupported partnership claims
- issues that require publishing secrets to reproduce
- production deployment claims not backed by HELM Kernel artifacts

