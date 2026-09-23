import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";

const media = vi.hoisted(() => ({
  job: vi.fn(),
  blob: vi.fn(),
  info: vi.fn(),
  location: vi.fn(),
  upload: vi.fn(),
  extract: vi.fn(),
  cancel: vi.fn(),
  attachRecording: vi.fn(),
}));
vi.mock("@/lib/media", () => ({ media, downloadAttachment: vi.fn() }));

import { schema, type GraiteEditor } from "../schema";
import { EditorSurface } from "../EditorSurface";
import { MediaContext } from "../media/context";

// jsdom has no layout: give floating-ui/ProseMirror the rect APIs they call.
const rect = () => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON() {
    return this;
  },
});
Element.prototype.getBoundingClientRect = rect as never;
Element.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;
Range.prototype.getBoundingClientRect = rect as never;
Range.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;

const FILE = "0123456789abcdef0123456789abcdef-voice.wav";
const DONE = {
  id: "j1",
  status: "done",
  progress: "Saved locally",
  error: "",
  file: "",
  text: "",
  title: "Transcript · voice.wav",
  page: null,
};

/** A page whose media block is waiting for extraction job `j1`, mounted as the app mounts it. */
function mount() {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  render(
    <MediaContext.Provider value={{ pageId: "p1", onTreeChanged: vi.fn() }}>
      <EditorSurface
        editor={editor}
        instructionsOnly={false}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
        onChange={() => {}}
      />
    </MediaContext.Provider>,
  );
  act(() => {
    editor.replaceBlocks(editor.document, [
      { type: "localMedia", props: { file: FILE, name: "voice.wav", kind: "audio", job: "j1" } },
    ]);
  });
  return editor;
}

const text = (block: unknown): string =>
  JSON.stringify((block as { content?: unknown }).content ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  media.blob.mockResolvedValue(new Blob(["audio"]));
  media.info.mockResolvedValue({ pages: 1 });
});
afterEach(cleanup);

it("puts the text a finished job carries under the file, without fetching a result file", async () => {
  media.job.mockResolvedValue({ ...DONE, text: "First sentence.\n\nSecond sentence." });
  const editor = mount();
  await waitFor(() => expect(editor.document[1]?.type).toBe("toggleListItem"));
  expect(text(editor.document[1])).toContain("Transcript · voice.wav");
  expect(editor.document[1]!.children.map(text).join(" ")).toContain("First sentence.");
  expect(editor.document[1]!.children.map(text).join(" ")).toContain("Second sentence.");
  // The job is cleared, so the block does not poll or insert the text a second time.
  expect((editor.document[0]!.props as { job: string }).job).toBe("");
  // Only the audio itself was read: there is no transcript file in `_assets` to fetch any more.
  expect(media.blob.mock.calls.every((call) => call[1] === FILE)).toBe(true);
});

it("still reads the result file of a job that finished before text travelled with the job", async () => {
  const legacy = "fedcba9876543210fedcba9876543210-transcript.md";
  media.job.mockResolvedValue({ ...DONE, file: legacy });
  media.blob.mockImplementation(
    async (_page: string, file: string) =>
      new Blob([
        file === legacy
          ? "# Transcript · voice.wav\n\nSource: [voice.wav](x.wav)\n\nOld result."
          : "audio",
      ]),
  );
  const editor = mount();
  await waitFor(() => expect(editor.document[1]?.type).toBe("toggleListItem"));
  const body = editor.document[1]!.children.map(text).join(" ");
  expect(body).toContain("Old result.");
  expect(body).not.toContain("Source:");
  expect(media.blob).toHaveBeenCalledWith("p1", legacy);
});
