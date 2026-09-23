import { describe, expect, it } from "vitest";
import { readEvents } from "@/lib/ai";
import { splitThinking } from "./thinking";
import { withCitationLinks } from "./MarkdownAnswer";

describe("chat streaming", () => {
  it.each(["\n", "\r\n"])("preserves fragmented UTF-8 and SSE frames with %j", async (newline) => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"token","text":"café"}\n\ndata: {"type":"done"}\n\n'.replace(/\n/g, newline),
    );
    const response = new Response(
      new ReadableStream({
        start(c) {
          for (const b of bytes) c.enqueue(new Uint8Array([b]));
          c.close();
        },
      }),
    );
    const received: unknown[] = [];
    await readEvents(response, (e) => received.push(e));
    expect(received).toEqual([{ type: "token", text: "café" }, { type: "done" }]);
  });
  it("rejects a truncated stream and a provider error", async () => {
    await expect(
      readEvents(new Response('data: {"type":"token","text":"partial"}\n\n'), () => {}),
    ).rejects.toThrow("before the answer");
    await expect(
      readEvents(new Response('data: {"type":"error","text":"Bad key"}\n\n'), () => {}),
    ).rejects.toThrow("Bad key");
  });
  it("passes sources and limits through to the caller", async () => {
    const frames = [
      { type: "sources", sources: [{ n: 1, kind: "page", page_path: "P", title: "P" }] },
      {
        type: "limits",
        items: ["Searched 3 pages."],
        excluded_local_only: ["Private"],
        pending_chunks: 2,
      },
      { type: "done" },
    ];
    const received: unknown[] = [];
    await readEvents(
      new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")),
      (e) => received.push(e),
    );
    expect(received).toEqual(frames);
  });
  it("ends cleanly when the answer was stopped", async () => {
    const received: { type: string }[] = [];
    await readEvents(new Response('data: {"type":"cancelled"}\n\n'), (e) => received.push(e));
    expect(received).toEqual([{ type: "cancelled" }]);
  });
  it("turns citation markers into clickable sources", () => {
    expect(withCitationLinks("Fact [1] and [2, 3].")).toBe(
      "Fact [1](graite-cite:1) and [2](graite-cite:2)[3](graite-cite:3).",
    );
    expect(withCitationLinks("An array like [a, b] is untouched.")).toBe(
      "An array like [a, b] is untouched.",
    );
  });
  it("keeps partial thinking blocks out of the answer", () => {
    expect(splitThinking("<think>Reasoning")).toEqual({ answer: "", thinking: "Reasoning" });
    expect(splitThinking("<think>Reasoning</think>Answer")).toEqual({
      answer: "Answer",
      thinking: "Reasoning",
    });
    expect(splitThinking("<thi").answer).toBe("");
  });
});
