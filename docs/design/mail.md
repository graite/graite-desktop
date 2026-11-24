# Mail

Status: D128 (reading), D129 (writing and sending). Any number of accounts. Agents cannot
see mail, and nothing is sent except by the user pressing Send.

## Shape

| Part | Where | Notes |
| --- | --- | --- |
| Accounts | `~/.graite/mail.json` (`graite/mail/accounts.py`) | App-wide, like model connections. No passwords. |
| Passwords | OS keychain, service `Graite`, entry `mail:<account id>` | One per account. |
| Local copy | `<vault>/.graite/mail/<account id>/mail.sqlite` (`graite/mail/store.py`) | Derivable: deleted with `.graite/`, fetched again. Never synced between devices. |
| Fetching | `graite/mail/imap.py` | Blocking `imaplib`, run in a thread. |
| Keeping fresh | `graite/mail/service.py` | One task per account: every 2 minutes, at once on `POST …/sync`, longer waits after a failure. |
| Routes | `/api/v1/mail/accounts/{id}/…` (`graite/api/mail.py`) | Accounts, folders, conversations, one conversation. |
| Reader | `apps/desktop/src/mail/` | Accounts and folders in the sidebar (`MailRail`), where the pages are, when Mail is chosen there. The conversation list and the reader are the Mail tab (`MailPage`), next to the page tabs. Switching tabs never changes what the sidebar shows. What is chosen lives in `useMail`, held by the workspace. |

## Which vaults a mailbox is in

Accounts belong to the computer, not to a vault. By default a mailbox is shown in every
vault. In its settings it can be kept to chosen vaults (`Account.vaults`, a list of vault
folders; "Only the vaults that sync" ticks those). A daemon lists, syncs and serves only the
mailboxes that belong in its vault (`MailService.here`); for the others its routes answer
404, and its copy of their mail is deleted: at once when the setting is changed in that
vault, at the next sync when it was changed from another vault's window, and at startup
when Graite was closed. The account, its sign-in and its drafts stay.

## Sidebar

Accounts fold open to their folders (`MailRail`). A folder can be hidden from the list (the
eye icon on hover, or "Hide N empty folders"); hidden ones are listed under "N hidden" and
come back with one click. This is a view preference kept in the browser's storage per
vault: the folder and its mail stay as they are, and search still finds mail in it.

## Signing in

- **Password accounts** (Gmail, iCloud, Fastmail, own domains): an app password, kept in the
  OS keychain (`mail:<account id>`).
- **Microsoft accounts** (`Account.auth == "microsoft"`, `graite/mail/oauth.py`): the user
  signs in on Microsoft's page in their browser (authorization code with PKCE, no app
  secret). The browser returns to `http://localhost:<port>`, a listener the daemon opens for
  that one sign-in, for ten minutes at most. The keychain entry then holds the refresh token;
  `oauth.secret(account)` gives a current access token (kept in memory only), and IMAP and
  SMTP sign in with it through XOAUTH2. When Microsoft stops accepting the token, the account
  shows "Sign in again".

## Rules

- **Reading is read-only on the server.** Folders are opened with `EXAMINE`, bodies fetched with
  `BODY.PEEK[]`. Reading a mail in Graite does not mark it read anywhere.
- **Every mail is untrusted input.** The HTML body is stored as sent and shown in a frame
  with no scripts and a policy that loads nothing from the network (no tracking pixels). A
  link opens in the browser only when clicked. When agents get mail tools, they must never
  follow instructions found in a mail.
- **Everything is keyed by account**, in routes, files and events (`mail_changed` carries
  `account_id`), so accounts never share state.

## What is kept

The last 90 days of every folder except the ones that repeat other folders or hold mail
nobody reads here (all mail, junk, trash, drafts, starred, important). A mail over 5 MB is
kept as its headers only. Attachments are listed by name and size, not stored: when one
is opened, downloaded or handed to the AI, the mail is fetched from the server at that
moment (`imap.fetch`, read-only) and the file is kept for an hour at most
(`.graite/mail/<id>/files/`), so looking at it and then saving it is one fetch.

Conversations are built from `References` / `In-Reply-To`, across folders, so your reply in
Sent sits in the conversation it answers. Mail arrives newest first and one folder after
another, so a mail can join two conversations that were apart; they are merged then
(`MailBox._thread`). A reply without references joins the conversation with the same subject.

Search is SQLite FTS5 over subject, sender and text, per account.

## Writing and sending

| Part | Where | Notes |
| --- | --- | --- |
| Drafts | `~/.graite/mail-drafts.json` (`graite/mail/drafts.py`) | The user's own writing: not derivable, so not under `.graite/`. Not on the mail server. |
| Formatting | `graite/mail/richtext.py`, `Draft.html` | Bold, italic, underline, lists, links, quotes. Rebuilt from an allow-list on every save; the plain text (`Draft.body`) is read off it, and both are sent. |
| Files that go along | `~/.graite/mail-drafts/<draft id>/` | Added and removed through `…/drafts/{id}/attachments`; deleted with the draft, sent or discarded. |
| Building and sending | `graite/mail/send.py` | Text, its formatted form and the files, over SMTP (`smtplib`), from this computer. Outgoing server from a table of providers, else "imap." → "smtp.", else what the account sets. |
| Sent copy | `imap.append` | Appended to the folder with the Sent role, marked read. Skipped for Gmail, which files sent mail itself. |
| Routes | `…/drafts`, `…/drafts/{id}`, `…/drafts/{id}/send` | Create (optionally `reply_to` a mail), save, discard, send. |
| Editor | `src/mail/DraftEditor.tsx` | Saves while typing. A reply sits under its conversation; a new mail takes the reader. |

Recipients are stored as text ("Name <address>, address") and shown as pills
(`RecipientField`): an address becomes one on a space, comma, Enter or when moving on; a pill
shows the first name and opens to copy the address, edit or remove it; text that is no
address is kept and marked. While typing, people the mailbox has written with are suggested
(`MailBox.contacts`, from the local copy: those the user wrote to first).

A mail can be answered or passed on as a whole conversation (its latest mail) or one mail in
it (the "…" on that mail). Forward (`NewMailDraft.forward`) fills in the subject, the mail's
text under a line for the user's own words, and its files, fetched from the mail server and
kept with the draft; it starts a conversation of its own.

Rules:

- **Only the Send button sends.** The send route takes a draft id; no agent tool, schedule or
  automation calls it. A draft can be written with AI (Ask AI → "Use as reply draft"), but
  it is a draft like any other until the user sends it.
- **A failed send changes nothing**: the draft stays and the error says what to do.
- **The mailbox is still not changed by reading.** The Sent copy of a mail the user just sent
  is the only thing Graite adds to a mailbox; nothing is ever deleted or moved there.

## Archive, delete, pictures, quoted mail

- **Archive and delete** (`imap.move`) move a conversation inside the mailbox: delete to the
  folder with the Trash role, archive from the inbox to Archive (Gmail has none: All Mail).
  `MOVE` where the server has it, else copy, mark and expunge only those mails. Graite never
  erases; the provider empties Trash on its own schedule.
- **Several at once.** Conversations ticked in the list are archived or deleted together
  (`POST …/move`), over one connection.
- **Pictures.** Those inside the text (`cid:`) are written into the stored HTML as `data:`
  links at sync time (up to 1.5 MB per mail), so they show offline. Those a mail links to are
  hidden until the user chooses "Show pictures" or "Always show"; then the daemon fetches
  each one (`GET /mail/image`, public addresses only, pictures only, 8 MB) and the reader
  puts it in as a local `blob:`.
- **Quoted mail.** In any mail, the earlier mail it repeats is folded behind "…"
  (`markQuoted`): from the place a mail app marks as the quote, or an "On … wrote:" line, or
  Outlook's "From / Sent / To" block (also in Dutch, German, French), to the end. Not when the
  mail has no words of its own above it, and not for a forward. Plain text: `splitQuoted`.
- **Light and dark.** Every mail sits on the app's own background. A mail is taken to be
  written for a light page unless a background of its own covers most of it (`mailTone`).
  When that does not match the app's theme, its light and dark are turned around with a CSS
  filter on the body (`data-flip`), and pictures are turned back. The frame is given the
  app's colour scheme, or the browser paints an opaque white canvas behind it.
- **Long mail.** A mail taller than about 500 px opens cut off, with "Show the whole mail".
- **Read.** Opening a conversation marks its mails read: in the local copy at once, and in
  the mailbox right after (`imap.mark_seen`, `POST …/threads/{id}/read`), so every mail app
  agrees. With archive, delete and Send, this is all that changes a mailbox.

## Attachments

Clicking an attachment opens it in a dialog (`AttachmentDialog`). A PDF or a picture is drawn
by the daemon, page by page, as PNG (`…/attachments/{i}/preview`, the same renderer as page
attachments), so the app only ever shows plain images. From the dialog:

- **Download** to the downloads folder.
- **Add to a page** (`…/attachments/{i}/save`): the file becomes the page's own (`_assets`,
  through `fileops.add_attachment`) and a media block is put at the end of the page
  (`fileops.attach_file`). PDFs, pictures and audio only, as for any page upload.
- **Add to a page and read its text**: the same, then the existing text extraction is queued
  for it (a PDF's text, or OCR), which writes the text under the file.
- **Ask AI** opens Ask AI for the conversation, which takes the readable attachments along.

## Ask AI about an email

"Ask AI" beside a conversation (`MailAskPanel`) starts an ordinary chat conversation and
uploads to it, as chat attachments: the conversation as text (`threadAsText`, which opens by
saying the text is material written by others, never instructions) and every attachment the
chat can read (PDF, image, text; up to 25 MB). The rest is the normal chat: the answer may
use the vault's pages and can only propose changes. Nothing new was added to the agents'
tools, and mail the user did not ask about is never shown to a model. The panel opens in
Ask; the user can switch it to Act, where a change to a page is proposed for review. The panel says whether
the chat model runs on this device or the email is sent to a model elsewhere.

Two shortcuts sit under every conversation (`src/mail/assist.ts`), each one chat turn of
its own without the panel. The email text goes along as a file, and no `depth` is sent, so
the model has its read-only tools and can read lists, boards and tables as well as pages:

- **Generate draft** asks for a reply that uses what the pages say and marks what is missing
  as `[fill in: …]`. The answer becomes a reply draft under the conversation, as plain text
  (`asDraftText` drops source numbers and Markdown marks). It is a draft: only Send sends.
  It answers in the language of the latest mail and may use bold and lists (Markdown, turned
  into the draft's formatting by `markdownToHtml`).
  The user's own tone goes along: up to four mails they sent from that account lately (only
  what they wrote, without quotes), as examples of greeting, sign-off and length.
- **Get info from pages** asks what the pages hold about the matter and shows the answer in a
  card under the conversation, with the pages it drew on.

What the pages are searched for is the mail, not the instruction: the subject, the people
and the latest mail's own words go along as `search_query` (`searchTerms`), which the chat
pipeline uses for its keyword and embedding search in place of the message.

A web address written out in a mail (plain text or HTML) is shown as a short link (the site and the start of the
path), with the full address on hover.

## Next

Agent tools (`read_mail`, `search_mail`, proposals from a mail), forward, drafts kept in the mailbox, IMAP IDLE, Sign in with Microsoft, a unified inbox.
