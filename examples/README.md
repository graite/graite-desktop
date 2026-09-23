# Example vault

`examples/vault` is the vault that `just dev` opens (see `apps/daemon/.env.example`). It is a
small, self-contained set of pages that exercises the editor, page links, a board with
properties, a journal and an agent definition. Nothing in it is personal.

When the daemon opens it, it writes derived state (`.graite/`, `NAVIGATION.md`,
`NAVIGATION-DEEP.md`) and bumps `updated:` in the frontmatter of pages you edit. Those files
are gitignored; please do not commit `updated:` bumps from casual edits either.

The on-disk format is described in `docs/vault-format.md`.
