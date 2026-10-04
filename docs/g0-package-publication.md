# G0 package publication barrier

`publish-g0-packages.yml` first reads private integration-helm qualification
through `G0_EVIDENCE_READ_TOKEN`, checks the authenticated Actions artifact
digest and exact main workflow revision, then calls the pinned
`verify-publication.py` / `gate.py verify`. Missing access refuses.

An all-PASS canary can run only as an explicit dry-run against
`Mindburn-Labs/g0-publication-sandbox`. A deliberately failed T104 canary must
stop before package assembly. Neither canary builds, publishes or changes a
package version. No npm authority is available to the verification job.

Real publication additionally binds this repository's exact source revision
and the full npm tarball sha256 set. Tarballs are checked again in the separate
publish job before any registry request. npm lifecycle scripts are disabled
at publication. The workflow uses npm trusted publishing (OIDC), requiring
the repository/workflow trusted publisher to be configured for each package;
it never falls back to a human npm token. CLI minimum follows the
[npm trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/).

Current core and Claude package manifests are private; the Codex package has
no manifest at the source baseline. This gate does not alter those product
decisions. It refuses private or absent packages until their owners release
them. It also cannot grant production authority while any G0 scenario remains
uncovered. A broker for private IH reads and hosted canary readbacks remain
external prerequisites.
