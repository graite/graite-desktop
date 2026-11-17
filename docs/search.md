# Search in Graite

Graite has two ways to get something out of your pages: **find** it yourself, or **ask** the
AI about it. Both use the same local index. Neither sends anything anywhere unless you chose
a cloud model for chat.

## Find: Ctrl/⌘ K

Press **Ctrl K** (**⌘ K** on a Mac) anywhere in the app and type a few words.

- Page **titles** match as you type, from the first letter.
- A moment later, pages whose **text** matches are added, each with the heading the match is
  under and the words around it.
- The last word counts as the start of a word, so `invoi` already finds "invoice".
- The line at the bottom says how many pages were found, how long it took, and whether the
  search used **words** only or **words and meaning**. Meaning is used when a search model is
  installed (Settings → Search) and loaded; opening the palette loads it.
- **Enter** opens the page. The last row hands your words to chat as a question.

Find never uses the chat model, so there is nothing to wait for. It looks through every page,
including pages you marked local-only or closed to AI: it is you who is searching.

## Ask: chat

Ask a question in the chat panel or on the Studio page. The AI searches your pages, reads the
passages that match and answers with numbered sources you can open.

### Where it looks

In a page's chat, the chips under the message box set the scope:

| Chip | The AI may search |
|---|---|
| **This page** | the page you are on |
| **+ subpages** | this page and everything under it |
| **Everywhere** | all your pages |

The menu next to the chips has two more choices: pick the pages yourself, or none.

**"Everywhere" means the AI may search everything. It never means the AI reads everything.**
It runs a search, then reads the few passages that match. A vault of ten thousand pages costs
an answer no more than a vault of ten.

### @page

Type **@** and the start of a page name, then pick the page. That page is **pinned** for this
question: the AI gets its text first, whatever the search finds. Use it when you know which
page the answer is about ("What changed in @Offline mode since the last sync?").

### Quick or Deep

The button next to the mode says **Quick** or **Deep**. Click it to switch; Graite remembers.

- **Quick answer** (the default): one search, the best few passages, one answer. This is the
  fast path, and the right one for most questions.
- **Deep research**: the AI first splits your question into a few searches, reads what each
  finds and makes a short note of it, then writes the answer from the notes. You see the
  steps as they happen. It takes several times as long; use it for questions that span
  pages ("Compare what Fernhill and Marlow & Finch need").

Requests that change your pages ("add a task…", "create a page…") and the Draft and Act modes
always let the AI use its tools, whichever is selected.

### What an answer shows

- **Sources** under the answer: the passages it was given. Click one to open the page.
- **Steps**: in Deep research and whenever the AI used a tool, the line above the answer
  opens into each step, for example `Searched "invoice Q3" · 6 hits · 120 ms`.
- **Details**: a small line under the answer, for example
  `1.2 s to first word · 38 tokens/s · 640 context tokens · 3 pages`. Click it for the rest:
  how long finding context took, how large the prompt was and how much of it the model could
  reuse from the previous turn.

## Making it faster

On a local model, most of the wait is the model reading the prompt. Three settings matter:

- **Context per answer** (Settings → Search): the most text from your pages one answer may
  use. 3,000 tokens is the default; lower is faster.
- **Quick** rather than Deep.
- A narrower scope or an **@page** when you know where the answer is.

## The index

Settings → Search shows the state of the index: pages indexed, how many pages have a
one-line **summary**, and when it was last updated. **Rebuild index** starts it again from
your files; it is safe at any time, because the index is derived from the pages.

Summaries are one sentence per page. The AI reads them as a map of your vault instead of
opening pages to see what is in them. They are written in the background by the chat model on
your computer, only while that model is loaded, and only for pages whose text changed. With a
cloud model selected no summaries are written; a page's first lines stand in.
