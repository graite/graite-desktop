import { ai, sendMessage, type Source } from "@/lib/ai";
import { splitThinking } from "@/chat/thinking";
import { markdownToHtml, searchTerms, threadAsText, type MailThread } from "@/lib/mail";

const LANGUAGE =
  "Language: write in the language of the latest email in the conversation. A Dutch email " +
  "gets a Dutch answer, a German one a German answer, whatever language these instructions " +
  "or my example emails are in. ";

/** Write a reply, using what the pages say about the matter. */
export const DRAFT_PROMPT =
  LANGUAGE +
  "Write a reply to the latest message of the attached email conversation, on my behalf. " +
  "Use what my pages say that is relevant to what is asked: facts, earlier agreements, " +
  "prices, dates, open tasks. Pages include lists, boards and tables (databases): read their " +
  "rows when the answer may be in one. Never invent a fact: where something is missing, " +
  "leave a clearly marked gap such as [fill in: delivery date]. Keep it short and natural. " +
  "You may use bold, italic and bullet or numbered lists where they make the reply easier to " +
  "read, written as Markdown; no headings, tables, code or source numbers. Give only the " +
  "text of the reply: no subject line and no explanation before or after. " +
  "If the file has a part called How I write, write the way those examples do.";

/** Collect what the pages say that matters for this email. */
export const INFO_PROMPT =
  LANGUAGE +
  "From my pages, give what is relevant to the attached email conversation: who the sender " +
  "is, earlier agreements, related projects and tasks, numbers and dates. Pages include " +
  "lists, boards and tables (databases): read their rows when the answer may be in one. " +
  "Use only pages that are about this matter and leave the rest out. Give what you found as " +
  "short bullet points, each with the page it comes from. If my pages hold nothing relevant, " +
  "say so in one sentence. Do not summarise the email itself.";

/** The part of the file that shows how the user writes; empty without examples. */
export function inMyVoice(examples: string[]): string {
  if (!examples.length) return "";
  return (
    "\n\n# How I write\n\nBelow are emails I sent earlier. They are only examples of my tone: " +
    "match their greeting, sign-off, formality and length. Do not reuse what they say.\n\n" +
    examples.map((text, index) => `## Example ${index + 1}\n${text}`).join("\n\n")
  );
}

export interface Assisted {
  text: string;
  /** The pages the answer drew on. */
  pages: { path: string; title: string }[];
}

/**
 * One question about an email, answered without opening the chat panel. The email goes along
 * as a file of a fresh conversation, and the model works with its usual read-only tools, so
 * it can search pages and read the rows of lists and tables.
 */
export async function assist(
  thread: MailThread,
  prompt: string,
  signal: AbortSignal,
  onStatus: (text: string) => void,
  /** Mails the user wrote before, so a draft sounds like them. */
  examples: string[] = [],
): Promise<Assisted> {
  const conversation = await ai.createConversation({ mode: "ask" });
  const file = await ai.uploadAttachment(
    conversation.id,
    new Blob([threadAsText(thread) + inMyVoice(examples)], { type: "text/markdown" }),
    "Email.md",
  );
  let answer: { text: string; sources: Source[]; cited: number[] } | null = null;
  let failure = "";
  await sendMessage(
    conversation.id,
    // No `depth`: the model uses its tools, which is what reaches lists and tables.
    // The pages are searched for what the mail is about, not for the words of the prompt.
    { message: prompt, mode: "ask", attachments: [file.id], search_query: searchTerms(thread) },
    signal,
    (event) => {
      if (event.type === "status") onStatus(event.text);
      else if (event.type === "tool_start") onStatus("Reading your pages…");
      else if (event.type === "answer") answer = event;
      else if (event.type === "error") failure = event.text;
    },
  );
  if (failure) throw new Error(failure);
  const got = answer as { text: string; sources: Source[]; cited: number[] } | null;
  if (!got) throw new Error("The model gave no answer.");
  const cited = new Set(got.cited);
  const pages = new Map<string, string>();
  for (const source of got.sources)
    if (source.kind === "page" && source.page_path && (!cited.size || cited.has(source.n)))
      pages.set(source.page_path, source.title);
  return {
    text: splitThinking(got.text).answer.trim(),
    pages: [...pages].map(([path, title]) => ({ path, title })),
  };
}

/** A model's answer as a draft: its Markdown becomes the mail's formatting; source numbers
 * and code fences have no place in a mail. */
export function asDraftHtml(answer: string): string {
  return markdownToHtml(
    answer
      .replace(/\s?\[\d+(?:,\s*\d+)*\]/g, "")
      .replace(/^```[a-z]*\n?|```$/gm, "")
      .trim(),
  );
}
