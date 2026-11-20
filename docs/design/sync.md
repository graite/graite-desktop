# Sync between devices

Status: stages 1 and 2 built (devices sync while they are on, and changes wait in the cloud
for a device that is off). Decisions D117, D118, D119. The cloud half is
`graite-inference/graite_cloud/sync/`.

## What it does

One vault on several devices of the same Graite account. A change made on one device reaches
the others through Graite Cloud, which passes it on and cannot read it: file contents and
file names are sealed on the device.

Not yet: sharing pages with other people (stage 4). Using another computer's models is at
the end of this page.

## Keys (`sync/crypto.py`, `sync/account.py`)

| Key | Made | Kept |
|---|---|---|
| Account key | on the first device | OS keychain; on Graite Cloud wrapped with an Argon2id key from the **sync passphrase** |
| Space key (one per synced vault) | when sync is switched on for a vault | OS keychain; on Graite Cloud wrapped with the account key |
| Account key pair (X25519) | with the account key | private half wrapped with the account key; unused until sharing |

- **The passphrase is six random words** made on the first device (`crypto.new_passphrase`,
  EFF large wordlist, about 77 bits), not chosen by the user. It is kept in the OS keychain next
  to the account key, so any unlocked device can show it (`GET /api/v1/sync/passphrase`).
  Capitals, dashes and extra spaces are ignored when it is typed.
- A new device signs in, enters the passphrase once, and joins a space.
- **There is no recovery key.** Graite Cloud never holds the only copy of anything, so a lost
  passphrase loses no page. **Reset sync** (`POST /api/v1/sync/reset`, cloud
  `DELETE /api/v1/sync/keys`) deletes the account's keys, spaces, device lists and waiting
  changes and closes its sockets; a new passphrase is then chosen. Every other device sees
  that its key no longer matches and that its space is gone, asks for the new passphrase, and
  joins again; joining compares files by hash. It also serves a lost device and a wish for
  new keys.
- Sealing is XChaCha20-Poly1305 with a random nonce (PyNaCl / libsodium). A frame that does
  not open with the space key is dropped.

## What a device tracks (`sync/state.py`, table `sync_files`)

One row per file: content hash, size, mtime, a **version vector** (`{replica: counter}`), who
made the version and when, and a tombstone flag for deleted files (kept 90 days).

- Changes are found by **scanning** (size and mtime, then a hash), triggered by daemon events
  and once a minute. Edits made in other editors are picked up the same way.
- Everything in the vault syncs, plus `.graite/skills/`. The rest of `.graite/`, dot-folders
  and `NAVIGATION*.md` do not.
- The space and replica ids are in the index (`meta.sync_space`, `meta.sync_replica`), so
  deleting `.graite/` switches sync off; switching it on again compares every file by hash.

## Applying a version from another device (`sync/engine.py`)

| Their version is… | The device… |
|---|---|
| newer than ours | takes it: `FileOps.sync_write` (expected-hash check, the replaced page kept as a version, atomic move into place) or `sync_delete` (the file moves to `.graite/sync/deleted/`) |
| older, or the same | does nothing |
| made side by side, same bytes | merges the vectors |
| made side by side, different | keeps the **later** change (ties: the larger hash). Every device reaches the same answer, so all devices hold the same file at once. |

The device whose **own** edit was not kept then works it back in:

1. Three-way merge against the last version both devices had (`sync/merge.py`, by line; a
   page's frontmatter key by key, `updated` never counts). Clean: written as a new edit.
2. Overlapping, on a page: a **proposal** in the review queue (`conversation_id =
   sync:<device>`). The page shows the other device's version; accepting puts this device's
   text back, which then syncs like any edit.
3. Anything else: the replaced file is kept under `.graite/versions/`.

Paths from another device go through `state.syncable` before they touch the disk (no
traversal, nothing under `.graite/` except `skills/`), and `FileOps` checks again.

## Wire protocol (`sync/client.py`)

One outbound WebSocket per running daemon: `WS {cloud}/sync/v1/connect`, bearer token with
scope `sync`.

| Frame | Direction | Meaning |
|---|---|---|
| `hello {space_id}` | device → cloud | first frame |
| `welcome {replica_id}` | cloud → device | |
| `presence {peers: [{replica_id, device, digest}]}` | cloud → all | who is connected and what each holds |
| `op {payload}` | device → the others | one file version, content inline up to 256 KB |
| `peer {to, payload}` | device → one device | manifest request, manifest, file bytes in 256 KB chunks |
| `state {digest}` | device → cloud | HMAC of this device's (path, hash) list under the space key |

Payloads are sealed JSON. When two devices' digests differ, each asks the other for its
manifest and takes what it lacks; that is also how a device that was off catches up. A
replica is "up to date" when its digest equals that of the device that synced last.

## Changes that wait in the cloud (stage 2)

Graite Cloud gives every `op` the next sequence number of its space, stores it sealed
(`sync_ops`), passes it to the devices that are connected and answers its author with
`sent {id, seq}`. A device answers `ack {seq}` after applying a change; a device that
connects first receives what it missed, oldest first. A change is deleted as soon as every
other active device has confirmed it (its sender already has it), so while all devices are on nothing stays stored.

- **Sending is reliable:** a version stays `sent = 0` in `sync_files` until `sent` arrives,
  and unsent versions go out on every connect. An edit made with the app offline is not lost.
- **A device not seen for 30 days** is marked stale and stops holding the queue back. When it
  returns it starts at the newest change and takes the rest from another device.
- **A device that joins later** starts at the newest change, for the same reason.
- **Only changes up to 256 KB travel this way.** A larger file is announced through the
  queue and its bytes fetched from a device that is on.
- **A limit per account** (`plans.features.sync_queue_bytes`, 100 MB by default): over it,
  changes are still passed on but not kept, and a device that was off catches up from
  another device.
- When a version that was not sent yet wins over one from another device, it goes out with
  its own vector, so the other device still sees the two were made side by side and saves
  its edit.

## Limits

- A new device, a device away for more than 30 days, and files over 256 KB need another
  device to be on.
- A new device gets the vault from a device that is running.
- Review queue state, chats and settings do not sync; only files.
- Tables merge by line. Overlapping row edits keep the later one; the other is a version.

## Running it locally

```
# graite-inference
uv run alembic upgrade head && uv run graite-cloud serve --reload      # :8000
# two daemons, each with its own vault folder and GRAITE_CLOUD_URL=http://127.0.0.1:8000
# Settings → Graite Cloud: sign in, choose a passphrase, "Sync this vault";
# on the second: sign in, enter the passphrase, "Connect".
```

## Vaults and folders (D123)

Sync is per vault, and a computer can hold several vaults. A vault that another device
shares arrives in a folder of its own: under Settings → Sync devices, "Get this vault here"
asks for an empty folder, Graite switches to it and joins there. The vault that was open is
not touched and stays in the vault list. Adding the shared vault to the open one is still
possible (a small link); the two are then merged like any two devices that meet for the
first time ("Applying a version from another device").

Whether a vault syncs is two rows in its own database. For everything that cannot open that
database, the daemon keeps `.graite/sync.json` (`{"space_id", "name"}`) in step with them:
written when sync is switched on or found on at start, removed when it is switched off or
reset. The desktop shell reads it (`VaultProbe.synced`) to mark synced vaults in the vault
picker, the vault menu and Settings → General. Deleting the file loses nothing.

## AI on another of your computers (`graite/compute/`, D122)

A device that shares the vault can do AI work for the others: chat, reading documents (OCR),
speech to text and the assistant's voice. The app calls such a computer a "local AI
workstation". It is one switch per computer ("Make this computer a workstation", off by
default), kept in `compute.json` in the app folder. On the computer you work at, each of the
four tasks is moved to a workstation separately: under Settings → AI workstation, on the
Documents and Speech pages themselves, and (chat) in the model menu of any chat.

- **Transport.** Calls are `peer` frames like manifests and blobs, sealed with the space key:
  `c_call`/`c_more` carry the request (64 MB at most), `c_head`, `c_part`, `c_end` the
  streamed reply, and `c_stop` cancels. Bodies travel base64 in pieces of 192 KB. A device
  that disconnects fails the calls to and from it at once. A caller waits five minutes for
  the next piece, so long jobs send a beat every 20 seconds.
- **Serving** (`compute/serve.py`). Nothing is read from or written to the serving
  computer's vault.
  - `info`: what it offers (every local chat model it has, the one it uses itself first, and whether it has the OCR, speech and
    voice models with their engines).
  - `chat`: an OpenAI chat-completions body, run on the computer's own engine with the model
    the call names (`head.model`; none = the one that computer uses itself), under
    `Manager.use` (so it queues with that computer's own chats); the engine's stream is
    passed back untouched.
  - `ocr`: a whole image or PDF in; lines of JSON back (`{"progress"}`, then `{"text"}`).
    Like a document of its own, the chat model is unloaded first.
  - `stt`: a recording in (WAV for live turns, MP3 for files, decoded there); Whisper's
    result back as JSON. The Whisper server stays loaded for ten minutes.
  - `tts`: text and voice settings in; PCM back as it is spoken. A voice to clone is named
    by the SHA-256 of its clip; the reply status 428 asks for the clip, which is then kept
    in the app's cache folder. The engine stays loaded for ten minutes.
- **Calling.** Chat: the AI config's provider is `device` with the replica id of the serving
  computer; `Manager.use` returns a local `Provider` with an httpx transport that sends the
  request through `Compute.call` (`compute/transport.py`). Retrieval, tools and the review
  queue stay on the calling computer. The other three (`compute/remote.py`):
  `ocr_provider`/`stt_provider` `device` and `tts_provider` `device`, each with its
  `*_device_id`; `models/sources.py` returns the source `device`, and `recognize_device`,
  `transcribe_device`, `DeviceSpeech` and `DeviceVoice` stand where the local and Graite
  Cloud ones do. Voice activity and turn detection always stay on the calling computer.
- **No silent fallback.** A task set to `device` fails with a clear message when that
  computer is away; it does not go to Graite Cloud instead.
- **Privacy.** `is_cloud` is false for `device`: it is the user's own machine and only their
  devices hold the key.
  The calling computer picks the chat model in the workstation card; its name is the AI
  config's `model`. Two devices asking for different models make the workstation swap.
- **Not yet:** a serving computer that does not sync the vault; a direct connection on the same network (everything is relayed by
  Graite Cloud).
