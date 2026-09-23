# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting:
<https://github.com/graite/graite-desktop/security/advisories/new>. Do not open a public issue.

You will get an acknowledgement within a few days. Once a fix is ready we publish an advisory
and credit you unless you prefer otherwise.

## What is in scope

Graite is a desktop app with a local daemon. The boundaries we rely on are described in
`ARCHITECTURE.md` §10:

- The daemon listens on loopback only, with a random bearer token per launch.
- Agents have no write tools: every change to the vault is a proposal a person accepts.
- `vault://` and `/media` reject path traversal; `propose_*` cannot target paths outside the
  vault or under `.graite/`.
- Cloud API keys live in the OS keychain, never in the vault.
- Downloads (models, engines) are verified against pinned checksums before use.

Anything that lets a page, an agent, an MCP client or a downloaded file cross one of those
boundaries is a security bug. Findings about third-party engines (llama.cpp, whisper.cpp,
CrispASR) should go to those projects; tell us too if Graite's use of them is the problem.

## Supported versions

Pre-1.0: only the latest release receives fixes.
