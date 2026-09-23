# Personal assistant and realtime voice

One named assistant per vault. It talks with the user (typed or spoken), looks things up in
their pages, remembers them in ordinary pages, and keeps working on their goals in the
background. Everything it changes goes through `propose_*`, so page policy applies to it like
to any other agent. Decisions: D33 to D37 in `docs/decisions.md`.

## 1. Definition

`_agents/assistant.md` (the file name never changes; `name:` does). An agent definition
(`docs/vault-format.md` §3b) with three more keys:

```yaml
name: Ada                 # the Studio entry and the page title
assistant: true           # one per vault; a second one is reported and ignored
memory: 0198c4…           # page id of the memory root, so renames and moves are harmless
voice:
  language: auto          # or one of Chatterbox's 23 codes; auto follows the speaker
  exaggeration: 0.5
  cfg: 0.5
  reference: <uuid>-voice.wav   # in the memory root's _assets; only with consent_at
  consent_at: 2026-09-18T20:50:00Z
```

The body has four plain sections, `## Personality`, `## Context`, `## Guidelines`,
`## Goals` (`assistant/profile.py`). Text under other headings stays where it is. The generic
agent editor keeps these keys when it saves the file (`render_agent(keep=…)`).

## 2. Memory

`assistant/memory.py` creates a root page titled after the assistant, with `Memories` and
`Journal` under it, and sets `autonomy: auto-apply` with
`auto_apply_kinds: [append, create, edit, properties, delete]` on the root, once (D57). The
existing one-time opt-in still applies (`POST /assistant/memory/opt-in`); until then memory
updates wait in Review. Settings the user changes later are never overwritten. Deleting
`.graite/` loses the opt-in, the conversations and when memories were last recalled, not the
assistant or its memory.

**One page per memory (D56).** `Memories` carries a `graite:view` list grouped by `Kind`; each
memory is a child page whose title states one fact in a short general sentence, with an
optional body for detail and two properties: `Kind` (About, Preference, Person, Project,
Routine, Lesson, Other) and `Pinned` (checkbox). In Obsidian it is a folder of small notes.

**What reaches the prompt.** Only pinned memories sit in the constant head ("Your notes about
the user", `memory.core`, about 1,200 bytes), so the llama-server KV prefix stays reusable.
For each message `memory.recall` looks for memories that bear on it — FTS5 keyword hits plus
sqlite-vec neighbours within `RECALL_DISTANCE` (cosine ≥ 0.5), at most six and 1,500 bytes —
and attaches them to the question as "Memories that may be relevant". A greeting recalls
nothing. The vector half waits at most 1 s in voice and 3 s in chat; a slower first embedding
finishes in the background and warms the model for the next turn. The model can look further
with `search_memory` (assistant turns and memory jobs only; not over MCP). When a memory was
last recalled is kept in the index (`meta.memory_recalled`), not in the page. A cloud model
gets none of it when the memory root is `local-only`. The Journal is not in normal turns; the
background loop reads its tail with the pinned memories and the other memories' titles
(`memory.digest`).

**Writing.** In conversation the assistant saves or forgets a memory when asked
(`ASSISTANT_MEMORY`). After every assistant conversation, chat or voice, Ask or Act, the
`assistant_reflect` job runs: turns fold into one pending job per conversation, pushed back to
three minutes after the latest turn, scoped to the memory root and given the new part of the
transcript as a source. The rules (`service.MEMORY_RULES`) are shared with the tidy pass: one
general, durable fact per memory; never task or project status, lists of open items, what
already lives in the user's pages, one-off requests, transcription slips or guesses;
`search_memory` before adding; a changed fact is a new page plus a delete of the old one
(titles cannot be proposed as edits). Most conversations add nothing.

**Tidying.** `assistant_tidy` runs Sundays at 04:00 (`cron.TIDY_SOURCE`, "0 4 * * 0") and on
"Tidy now". It reads every memory with its kind, pin and last recall, merges duplicates,
generalises clusters into one memory, deletes what breaks the rules or is clearly outdated,
and fixes kinds and pins. Every change auto-applies and is listed under "Recent memory
changes", where it can be undone; a delete goes to the trash.

**Upgrade.** Assistants made before D56 have `Profile` and `Playbook` bullet lists. They keep
reaching the prompt until the user presses "Convert to cards" in the Memory tab
(`POST /assistant/memory/upgrade`): every bullet becomes a memory page (Profile section →
Kind, Playbook → Lesson, About pinned), the old pages go to the trash, and `delete` and
`properties` join `auto_apply_kinds` if the root still has the old default. Never on open.

**The Memory tab** shows one card per memory, grouped by kind, with a search box, a pin toggle,
"Forget", "Open page", and in-place editing of the title, several lines of detail, the kind
and the pin (page rename, `PUT /pages/{path}` with the base hash, `PUT /workspace/properties`).
Below: the last Journal entries, collapsed, and recent memory changes as proposal cards.
`GET /assistant/memory` lists the memories; `POST /assistant/memory` adds one.

## 3. Conversation

Assistant sessions are `conversations` rows with `kind = 'assistant'` (schema v8), outside the
chat list. `POST /assistant/conversations` returns the recent one or starts a new one after
six idle hours (`?fresh=true` forces it). Turns run through the ordinary
`POST /ai/conversations/{id}/messages`; the route hands the turn to
`assistant.service.build_turn`, which sets the definition's model, scope (widened to include
the memory root), tools, persona and memory. `answer.assistant_messages` is the prompt:
history is kept and `CLARIFY:` works, unlike an unattended run.

Recent dialogue has a reserved prompt budget; persona, memory, navigation and sources share
the remaining space. Current page evidence sits beside the current request, after the old
dialogue. The assistant retains citation identities without loading every historical excerpt
again. Source footers count passages actually read this turn, including a repeated read of an
existing citation. A greeting does not perform retrieval.

Page requests resolve explicit titles and spelled names against the accessible page index.
Voice also suggests close transcription matches, marked as uncertain; recent user page
references carry into follow-ups. A single candidate gets one bounded, scope-checked
`read_page` before generation. Multiple candidates remain ambiguous. Name matching only
triggers reads; mutations still use the normal proposal and page-policy checks. `read_page`
returns `next_offset` for long pages; further reads preserve distinct excerpt citations. `list_children(path="", offset=0)` navigates the vault root when the tree
does not fit. Current corrections override old memory; reflection must not preserve speech
misunderstandings as facts.

Spoken answers are brief by default, but requests for all items explicitly override that
default. Page citations remain in the transcript and are stripped by the speech chunker.

## 4. Background loop

The definition's `schedule` becomes a cron row with source `assistant:loop` and job kind
`assistant_loop`. One pass: skip if nothing outside the memory changed in six hours; otherwise
run the task in `service.loop_task` (goals, memory, pages changed since the last pass) with
read, search and the non-destructive propose tools. A final `QUESTION:` line ends the run as
`needs_input` and shows under "Questions for you". Both background jobs mark their payload
`preemptible`: `ForegroundGate` cancels and re-queues them (ten minutes later) when the user
sends a message or opens a voice session, and the `model` lane waits while a session is open.

## 5. Voice pipeline

```
mic PCM16 16 kHz ─▶ Reframer (512 samples) ─▶ Silero VAD ─▶ TurnAnalyzer + Smart Turn
   ─▶ whisper-server (resident) ─▶ answer_turn (voice prompt) ─▶ SpeechChunker
   ─▶ TTSEngine (crispasr: Chatterbox GGML) ─▶ PCM16 24 kHz ─▶ client player
```

- **Turn taking** (`voice/turn.py`, pipecat's analyzer): speech starts after 0.2 s above the
  VAD threshold. When it stops for 0.2 s, Smart Turn hears the whole turn so far (the newest
  8 s, left-padded, with 0.7 s of lead-in). Above 0.5 the turn is complete; otherwise listening
  continues and the model is asked again at the next pause. A pause the model called
  unfinished ends the turn anyway after 1.6 s (`STOP_SECS`), the floor for how long the user
  waits when Smart Turn is wrong.
- **Speech to text**: `SpeechServer` keeps `whisper-server` running for the session;
  `verbose_json` yields the language.
- **The turn**: `build_turn(voice=True, language=…)` adds the spoken-answer rules, turns
  thinking off (`chat_template_kwargs.enable_thinking=false`) and puts "(Reply in Dutch.)"
  next to the question.
- **Chunking** (`voice/chunker.py`): reasoning blocks, code, markdown marks, citations,
  bracketed references and URLs are not spoken. Sentences leave as soon as they are complete;
  the first chunk may end at a clause.
- **Waiting on tools** (`voice/fillers.py`): a search or page read takes seconds with nothing
  to hear. On the first `tool_start` of a turn, when nothing of the answer has been queued for
  speech yet, the session queues one short filler picked by what the tool does: search
  ("Let me check your pages."), read ("Let me look at that page."), propose ("I'll prepare that
  change."), anything else ("One moment."). Tables exist for English and Dutch, other
  languages fall back to English, and phrasings rotate. If a tool round is still running after
  4 s (`STILL_AFTER`) one more filler ("Still looking.") follows, at most once per turn.
  `request_clarification` gets none. Fillers go to the speaker queue directly, bypassing the
  chunker, so the chunker's reset on tool rounds is unaffected; they count for echo detection
  and playback position but are never part of the saved answer, and an interruption during a
  filler saves nothing. The `state` goes back to `thinking` on a `tool_start` once everything
  queued has been sent, and to `speaking` with the next audio.
- **Engines** (`voice/tts.py`): `get_engine()` is the only place that knows them.
  `engines/crispasr.py` owns a `crispasr --server --backend chatterbox` process on a loopback
  port with a generated key; `engines/stub.py` needs no model and keeps the path testable.
- **Resources**: `VoiceRuntime.open` checks free memory, holds the foreground gate, pins the
  chat model, and loads whisper, the TTS engine and the chat model together. One session at a
  time. `model_busy()` makes model-changing routes answer 409 meanwhile.

### Socket protocol — `WS /api/v1/voice/session?token=…&conversation_id=…&barge_in=false`

`mode=test` opens the pipeline without a conversation (§8): VAD, Smart Turn and Whisper only.

Close codes: 4401 unauthorized, 4409 a session is already running, 4412 not ready (the last
JSON event explains what to set up; `GET /voice/status` lists it beforehand).

| Direction | Message |
|---|---|
| client → | binary PCM16LE 16 kHz mono, any chunking |
| client → | `{"type":"played","ms":N,"done":bool}` playback position, a few times a second; `done` once everything was heard |
| client → | `{"type":"interrupt","ms":N}`, `{"type":"mute","on":bool}`, `{"type":"barge_in","on":bool}`, `{"type":"end"}` |
| → client | `state` (`loading`, `listening`, `transcribing`, `thinking`, `speaking`), `ready {sample_rate}` |
| → client | `vad {speaking}`, `turn {state: incomplete|complete, probability}`, `transcript {text, language, confidence, seconds, audio_seconds}` |
| → client | `input {frames, level}` once a second; `input_silent {reason: no_audio|silence}` after 3 s of nothing, `input_ok` on recovery |
| → client | `meter {level, vad}` (test mode only, ~10x a second) |
| → client | the turn's `run`, `status`, `tool_start`, `tool_end`, `proposal`, `clarify`, `limits`, `answer` |
| → client | `audio_start {utterance, text, sample_rate, greeting}`, binary PCM16LE, `audio_end {utterance, ms}`, `speech_end {ms}` |
| → client | `interrupted`, `error {text}` |

Types: `VoiceServerEvent` and `VoiceClientControl` in `packages/api-types`.

### Interrupting by speaking (D38)

On by default; `barge_in=false` (or the toggle in the talk bar) switches it off, and then the
microphone is ignored until the assistant is done. The button and Space always interrupt.

While the assistant thinks or speaks, frames go to `BargeInGuard` (`voice/bargein.py`):

1. **Sustained speech**: VAD >= 0.6 in 6 of the last 10 frames.
2. **Louder than our own echo**: `ReferenceTrack` keeps the loudness envelope of the PCM that
   was sent; the client's `played {ms}` reports (every 100 ms) are pinned to the count of
   microphone frames received so far, so both are on one clock whatever the network does.
   `EchoModel` learns the gain of microphone over a peak-held reference (the loudest the
   reference was over the last ~0.5 s, so no delay estimate is needed), from frames that do not
   stand out, minus the room's noise. A frame counts when it is 5 dB above gain x held. With
   headphones or real echo cancellation the gain is next to nothing and the gate is open.
3. **Real words**: `duck on` (the client drops playback to 25 %), about a second of audio is
   collected, Whisper transcribes the part from just before the candidate, and `judge()`
   decides: nothing / unclear (Whisper's log-probability below -0.6: words imagined into
   noise) / echo (an ordered stretch of what the assistant said, forgiving spelling, ignoring
   numerals) / backchannel ("ok", "ja", "mm-hm") reject and `duck off`; two or more words, or
   a stop word ("stop", "wait", "wacht", "nee", "halt", "attends", ...), interrupt. A rejected
   echo raises the gain at once; the collected audio of an accepted one primes the turn
   analyzer, so what was said while interrupting starts the next turn.

Events: `duck {on}`, `barge_in {state: checking | rejected | confirmed, reason?, heard?}`.
Either way the saved message keeps only what was heard, by the client's playback position, and
is marked `cut_short` — also when the interruption comes after synthesis finished, which is
the normal case because synthesis is faster than speech.

Limits: speakers louder than the user at the microphone keep gate 2 shut (fails safe); a
user who cuts in by repeating the assistant's own words is taken for echo until they say
something else; an isolated, very short "stop" may not reach six voiced frames.

### Saying hello first

A conversation opens with the assistant speaking: "Hi <name>." from the definition's
`user_name`, or "Hi there." without one, from a small per-language table
(`voice/runtime.py: greeting_text`, English when the language is automatic). It is synthesized
while the rest of the session loads and cached as PCM per voice and text under
`<app_dir>/cache/voice/`, so it plays at once on every later start. It arrives as
`audio_start {greeting: true}`, is shown as the assistant's line and is **not** saved as a
message — the conversation still starts with whatever the user says. It doubles as the
quickest proof that sound comes out at all.

Spoken turns are prompted differently from typed ones: `VOICE_ADDENDUM` plus a one-line
reminder repeated next to the question ("Spoken aloud: concise natural sentences; include
all items when asked."), where small models actually look. The output budget is the configured
`max_output_tokens`, not a voice cap: tool arguments (page edits, board cards) share it, and
brevity is the prompt's job.

## 6. Desktop

`src/assistant/`: `AssistantView` (tabs Conversation, Profile, Memory, Voice, Background,
Settings), `useVoiceSession` + `VoiceBar`. `lib/platform/audio-capture.ts` streams the
microphone (AudioWorklet, ScriptProcessor fallback, box-filter downsampling to 16 kHz);
`lib/pcm-player.ts` schedules the answer gaplessly and reports the playback position;
`platform.microphone({voice, deviceId, rearm})` asks for echo cancellation, re-arms the
shell's one-shot microphone latch and honours the input chosen in Settings (kept per device in
`localStorage`). The capture runs the AudioContext at the device's own sample rate and
downsamples, loads its worklet from the same-origin `/capture-worklet.js` (a `data:` URL is
blocked by the app's CSP) and falls back to a ScriptProcessor if no frame arrives within a
second; `Capture.info` reports which path, rate and device is live.

**Silence is said out loud.** The daemon reports `input`/`input_silent`/`input_ok` (above) and
logs one summary line per session — frames, peak level, peak speech probability, turns — so a
dead microphone is visible instead of looking like a broken assistant. The talk bar shows "I
can't hear your microphone", a Bluetooth hint (a headset in music mode has no microphone) and a
link to the test bench.

## 7. Setting up voice

On Linux, a Bluetooth headset in A2DP (playback-only) mode may leave the computer with no
microphone input. WebKitGTK reports this as `OverconstrainedError: Invalid constraint`, even
for `getUserMedia({audio: true})`. The capture fallback drops all optional constraints, then
checks available inputs after a failure and explains how to select Headset / Hands-Free
mode in the computer's Sound settings. Model readiness alone does not test microphone access.

1. Settings → Voice: press **Install** on the voice engine card (D39), and download Whisper,
   "Silero VAD", "Smart Turn" and "Chatterbox Multilingual".
2. Speech-to-text still needs a `whisper-server` executable (Advanced). Developers can point
   the voice engine at their own `crispasr` build under its Advanced section, or run
   `scripts/build-voice-engine.sh` to compile one for the computer's graphics card — it
   installs as the `local` variant and is preferred from then on.
3. Settings → Voice → **Voices**: add a voice (upload or record 10 to 30 s of clear speech,
   with the confirmation that it is yours to use), rename, delete, hear a sample. Then
   Studio → the assistant → Voice selects one, with language and the two sliders.
4. Settings → Voice → **Test your microphone and turn-taking** before blaming the assistant:
   two level bars (what the browser captures, what the daemon receives), the speech light,
   Smart Turn's verdict with its probability, and the transcript with its timings. Record and
   play back checks the webview alone; "Speak a sentence" reports the real-time factor.

## 8. Testing it without talking to the assistant

`WS /api/v1/voice/session?mode=test` needs no conversation, no chat model and no TTS: it runs
VAD → Smart Turn → Whisper and streams `meter`, `turn` and `transcript`, then listens again.
That is what Settings → Voice drives, and it is the right place to judge turn detection.

Judge it on **microphone audio**. Speech spliced together from TTS output with exact digital
zeros is out of distribution for Smart Turn: measured on 2026-09-20 its verdict for the same
window swung between 0.19 and 0.83 under a 32 ms trim, and a finished sentence scored 0.27
although each of its clauses scored 0.93 on its own. The identical audio with a −45 dBFS noise
floor — what a quiet room gives a real microphone — was judged correctly at both points (0.19
mid-thought, 0.66 when finished). The log-mel front end (`voice/features.py`) was checked
separately against `WhisperFeatureExtractor` and agrees to ~2e-6, so the input is not the
problem.
