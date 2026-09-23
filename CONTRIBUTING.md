# Contributing to Graite

Thanks for helping. This page is how changes land; `AGENTS.md` has the rules and conventions
(AI coding tools read it too), and `ARCHITECTURE.md` explains the system.

## Before you start

- Open an issue for anything bigger than a bug fix so we can agree on the shape first.
- Read `VISION.md`. Changes that break one of its four principles (files are the product,
  one writer, agents propose, no torch) will not be merged, however good the code.

## Setting up

See the *Develop* section of `README.md` and `docs/development.md`. In short: `just setup`,
`just dev`.

## The hard rules

`AGENTS.md` lists the eight rules every change follows (single writer, no agent write tools,
Obsidian-compatible Markdown, no torch, and so on), plus the code conventions. Read it before
your first change; reviewers check against it.

## Making a change

1. Branch from `main`.
2. Write the test first where the rules ask for one: every fileops change has a pytest, every
   converter change has a fixture in `packages/md-convert/fixtures/`, every UI behaviour has
   a vitest next to the component.
3. Run `just lint` and `just test`. CI runs the same plus a PyInstaller build and a smoke test
   of the packaged daemon on Linux, macOS and Windows.
4. If you made an architectural decision, add a row to the table in `docs/decisions.md`.
   Rows are appended, never edited; supersede with a new row.
5. Open a pull request. The template lists what reviewers check.

Formatting is ruff, prettier and rustfmt; `just fmt` runs all three.

Commit messages are imperative and scoped: `daemon:`, `desktop:`, `md-convert:`, `docs:`.

## The example vault

`examples/vault` is what `just dev` opens. Opening it writes `.graite/` and `NAVIGATION*.md`
(gitignored) and bumps `updated:` on pages you touch. Please do not commit those bumps unless
the page content changed on purpose.

## Licensing of contributions

Graite is licensed under the Apache License 2.0. By submitting a contribution you agree that
it is licensed under the same terms (Apache-2.0 §5). There is no CLA.

## Security

Do not report vulnerabilities in public issues; see `SECURITY.md`.
