## What

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `just lint` and `just test` pass locally
- [ ] Tests added or updated (every fileops change has a pytest; every converter change has a fixture)
- [ ] No `write_*` or `update_*` tool was added to the agent registry
- [ ] If a route or response shape changed: `just api-types` was run and the result is committed
- [ ] If an architectural decision was made: a row was added to `docs/decisions.md`
- [ ] Commit messages are imperative and scoped (`daemon:`, `desktop:`, `md-convert:`, `docs:`)
