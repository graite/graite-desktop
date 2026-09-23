# Graite — Vision

**Graite is a local-first knowledge workspace with agents that live on your machine.**
Obsidian's files, Notion's editor, NotebookLM's "talk to your knowledge", and a background
daemon that runs local models over the vault — with every AI change reviewed by a human.

## The bet

A large share of people and companies will want AI agents **at home**:

- **On their hardware.** Consumer GPUs and unified-memory laptops now run capable 4–30B
  models. The cost of inference at home is electricity.
- **Over their files.** Knowledge lives in markdown, PDFs, recordings and small tables, not in
  someone else's database. The vault must remain plain files that outlive the app.
- **At no marginal cost.** Scheduled agents that run nightly over thousands of pages are only
  viable when a run costs nothing. That changes what you are willing to automate.
- **With hard boundaries.** The agent can read everything you let it read and write nothing
  directly. What it is allowed to do is declared per folder in a file you can read.
- **With human sign-off.** Every change is a diff you accept, reject or edit. Autonomy is
  granted explicitly, per folder, per kind of change — and is always revertible.

Cloud models (Claude, GPT and others) plug into the same interface as an optional escape
hatch for hard reasoning. The product does not depend on them.

## Four principles

1. **Files are the product.** The vault is plain markdown that Obsidian, git and any text editor
   open unchanged. Everything Graite adds is derivable (the search index) or lives under
   `.graite/` (versions, trash, config). Delete `.graite/` and you lose nothing you wrote.
2. **One writer.** Every byte written into the vault goes through one module in the daemon
   (`fileops`). The editor, the shell and the agents never touch files directly. This is what
   makes hashes, versions, activity logs and conflict detection trustworthy.
3. **Agents propose, humans dispose.** Agent tool sets contain no write tools. The only way an
   agent changes the vault is a *proposal* — a diff with a summary — that a person (or an
   explicit per-folder policy) applies. Enforced by the tool set, never by the prompt.
4. **No torch.** Everything model-related runs through native GGML engines: llama.cpp
   (`llama-server`) for chat, embeddings and vision, whisper.cpp for speech. The daemon stays
   small, installs offline, and does not drag a CUDA/PyTorch matrix into packaging.

## What the first product is

A desktop app (Tauri shell, React UI, Python daemon) that opens a folder as a vault.

- **Notion-style editor over markdown.** Block editor with a `/` menu: headings, lists,
  toggles, callouts, tables, code, images, audio, video, PDF, page links, database views,
  dashboards. Every block round-trips to Obsidian-compatible markdown.
- **Pages as links, folders as pages.** Typing `/page` creates a child page; the child is a
  folder next to the parent with its own `page.md`, attachments, instructions and data.
- **Navigation files.** `NAVIGATION.md` lists every page and level. `NAVIGATION-DEEP.md` adds a
  one-line purpose per page, maintained by a background summarizer. Both are readable by
  humans and used by agents as their map.
- **Local models from a curated catalog.** Chat, embeddings, Whisper (speech), OCR/vision —
  picked from a short list of tested GGUF models, downloaded from Hugging Face with progress
  and checksums, loaded and unloaded by the daemon. Bring your own key for cloud providers.
- **Per-folder instructions and skills.** An `AGENTS.md` in any folder shapes how agents behave
  beneath it, cascading root to leaf. Pages can carry their own skills (`SKILL.md` files) the
  agent loads on demand.
- **Review queue.** Proposals appear as diffs, inline on the page and in a Review view.
  Accept, reject, edit-then-accept, batch accept. Conflicts are detected if the page changed
  underneath. Every applied change has a snapshot and a one-click revert.
- **Background daemon.** Job queue, cron schedules, Live Notes (a page that keeps itself
  updated on a schedule), embedding worker, transcription and OCR jobs. Runs while the app is
  open; designed to become a headless service later.
- **Semantic search.** Local embeddings plus full-text search over every page, transcript and
  OCR'd document, from `Cmd+K` and from agent tools.
- **Little databases and dashboards.** A page can own a SQLite database viewed as editable
  tables, queried by agents, and charted by an HTML dashboard rendered in a sandbox.

## What it is not (v1)

- Not a sync service. Use git, Syncthing, iCloud or Obsidian Sync; Graite is sync-agnostic.
- Not multi-user. One vault, one person, one machine. Teams and roles come later.
- Not a chat app with files attached. Chat is a way to drive the editor and the daemon.
- Not a model marketplace. A short curated list beats a thousand untested GGUFs.

## Later horizons

The architecture leaves room for each; none are built in v1.

- **API and MCP.** The daemon is already the API. Scoped tokens decide whether a client writes
  directly or only proposes; an OpenAI-compatible chat endpoint makes every existing chat
  client a Graite client; the skills registry is exposed as an MCP server, and an MCP client
  can register external tools as skills — still write-free, still behind proposals.
- **Remote access.** The daemon runs headless; remote access is off by default and, when on,
  runs over Tailscale first (Cloudflare or a self-hosted relay later) with per-device tokens.
  A mobile web app served by the daemon gives phones chat, search and the review queue,
  with inference staying at home.
- **Mobile and sync.** A phone app keeps a partial offline replica with the desktop daemon as
  hub. Sync conflicts become proposals in the review queue instead of conflict files.
- **Teams and roles.** Activities and proposals already carry an `actor`. Add principals and a
  per-folder ACL in `AGENTS.md` frontmatter; the review queue becomes a shared inbox.
- **Web browsing.** One more read-only skill in the registry, with Playwright as an optional
  extra.
- **Voice conversation.** Built as part of the personal assistant (`docs/design/voice-and-assistant.md`):
  Smart Turn decides when the user is done, whisper.cpp hears them, Chatterbox on GGML answers
  aloud; the chat loop did not change.
