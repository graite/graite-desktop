import { toBlocks } from "@graite/md-convert";
import { createReactBlockSpec } from "@blocknote/react";
import { useContext, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  FileText,
  Image as ImageIcon,
  Upload,
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
  MoreHorizontal,
  FolderOpen,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AudioPlayer } from "../media/AudioPlayer";
import { downloadAttachment, media } from "@/lib/media";
import { readableTranscript } from "../media/transcript";
import { MediaContext } from "../media/context";
import { Recorder } from "../media/Recorder";
import type { GraiteEditor, GraitePartialBlock } from "../schema";
import "../media/media.css";

function useLocalFile(file: string, preview?: number) {
  const { pageId } = useContext(MediaContext);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file || !pageId) return;
    const controller = new AbortController();
    let objectUrl = "";
    setUrl("");
    setError("");
    void media
      .blob(pageId, file, preview, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pageId, file, preview]);
  return { url, error };
}

function Preview({ file, name, kind }: { file: string; name: string; kind: string }) {
  const { pageId } = useContext(MediaContext);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const { url, error } = useLocalFile(file, kind === "audio" ? undefined : page);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (kind !== "pdf") return;
    let live = true;
    void media
      .info(pageId, file)
      .then((r) => {
        if (live) setPages(r.pages);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pageId, file, kind]);
  const download = async () => {
    setDownloading(true);
    try {
      await downloadAttachment(pageId, file, name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <>
      {error ? (
        <p role="alert" className="media-error">
          {error}
        </p>
      ) : !url ? (
        <div className="media-loading">Opening local file…</div>
      ) : kind === "audio" ? (
        <AudioPlayer key={url} src={url} name={name} />
      ) : (
        <img
          draggable={false}
          className="media-document-preview"
          src={url}
          alt={`${name}${kind === "pdf" ? ` · page ${page + 1}` : ""}`}
        />
      )}
      <div className="media-preview-footer">
        {kind === "pdf" && (
          <div className="media-pagination">
            <button
              aria-label="Previous PDF page"
              disabled={!page}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <span>
              {page + 1} / {pages}
            </span>
            <button
              aria-label="Next PDF page"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="media-more" aria-label={`Options for ${name}`}>
              <MoreHorizontal size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void download()} disabled={downloading}>
              <Download size={14} /> Download original
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!platform.revealFolder}
              onClick={() =>
                void media
                  .location(pageId, file)
                  .then((r) => platform.revealFolder?.(r.folder))
                  .catch((e) => toast.error((e as Error).message))
              }
            >
              <FolderOpen size={14} /> Show in folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

type MediaProps = { file: string; name: string; kind: string; job: string };
function MediaView({ id, props, editor }: { id: string; props: MediaProps; editor: GraiteEditor }) {
  const { pageId, onTreeChanged } = useContext(MediaContext);
  const [output, setOutput] = useState<"toggle" | "page">("toggle");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const callbacks = useRef(onTreeChanged);
  callbacks.current = onTreeChanged;
  useEffect(() => {
    if (!props.job) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await media.job(props.job);
        if (!live || !editor.getBlock(id)) return;
        setProgress(job.progress);
        if (job.status === "running") {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        let inlineText: GraitePartialBlock | undefined;
        if (job.status === "done" && !job.page) {
          // The text comes with the job. Results from before that were files in `_assets`.
          const text =
            job.text ||
            (job.file
              ? (await (await media.blob(pageId, job.file)).text()).replace(
                  /^# .*\n\nSource: .*\n\n/,
                  "",
                )
              : "");
          inlineText = {
            type: "toggleListItem",
            content: job.title,
            children: toBlocks(text) as GraitePartialBlock[],
          };
        }
        if (!live || !editor.getBlock(id)) return;
        editor.transact(() => {
          editor.updateBlock(id, { type: "localMedia", props: { job: "" } });
          if (job.status === "done") {
            editor.insertBlocks(
              [
                job.page
                  ? {
                      type: "pageLink",
                      props: {
                        path: job.page.path,
                        title: job.page.title,
                        target: job.page.title,
                        icon: "",
                      },
                    }
                  : inlineText!,
              ],
              id,
              "after",
            );
          }
        });
        if (job.status === "error") setError(job.error);
        if (job.page) callbacks.current();
        setProgress("");
      } catch (e) {
        if (!live) return;
        setError((e as Error).message);
        if (e instanceof ApiError && e.status === 404) {
          if (editor.getBlock(id))
            editor.updateBlock(id, { type: "localMedia", props: { job: "" } });
          return;
        }
        // Keep a running task reference on transient network failures, so it can recover.
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [props.job, props.file, editor, id, pageId]);
  const upload = async (blob: Blob, name: string) => {
    setError("");
    setBusy(true);
    try {
      const result = await media.upload(pageId, blob, name);
      if (mounted.current && editor.getBlock(id))
        editor.updateBlock(id, { type: "localMedia", props: { ...result } });
      else await media.attachRecording(pageId, result.file, result.name);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const extract = async () => {
    setError("");
    setBusy(true);
    try {
      const job = await media.extract(pageId, props.file, props.name, output);
      if (editor.getBlock(id))
        editor.updateBlock(id, { type: "localMedia", props: { job: job.id } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setCancelling(true);
    try {
      await media.cancel(props.job);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };
  const audio = props.kind === "audio" || props.kind === "recording";
  const Icon = audio ? AudioLines : props.kind === "image" ? ImageIcon : FileText;
  return (
    <div className="local-media-block" contentEditable={false}>
      <div className="media-heading">
        <span className="media-icon">
          <Icon size={19} />
        </span>
        <div>
          <strong>
            {props.name ||
              (props.kind === "recording"
                ? "Voice recording"
                : audio
                  ? "Audio"
                  : "Document or image")}
          </strong>
          <small>
            {audio ? "Audio file" : props.kind === "pdf" ? "PDF document" : "Image"} · Stored
            locally
          </small>
        </div>
      </div>
      {props.file ? (
        <>
          <Preview file={props.file} name={props.name} kind={props.kind} />
          <div className="media-actions">
            {props.job ? (
              <>
                <span role="status">
                  <LoaderCircle className="media-spinner" size={15} /> {progress || "Starting…"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void cancel()}
                  disabled={cancelling}
                >
                  {cancelling ? "Cancelling…" : "Cancel"}
                </Button>
              </>
            ) : (
              <>
                <div className="media-output">
                  <div role="group" aria-label="Where to add the text">
                    <button
                      type="button"
                      aria-pressed={output === "toggle"}
                      disabled={busy}
                      onClick={() => setOutput("toggle")}
                    >
                      Add here
                    </button>
                    <button
                      type="button"
                      aria-pressed={output === "page"}
                      disabled={busy}
                      onClick={() => setOutput("page")}
                    >
                      Create page
                    </button>
                  </div>
                  <small>
                    {output === "toggle"
                      ? "Collapsible text below this file"
                      : "A separate page, linked below this file"}
                  </small>
                </div>
                <Button size="sm" onClick={() => void extract()} disabled={busy}>
                  {busy ? "Starting…" : audio ? "Transcribe" : "Extract text"}
                </Button>
              </>
            )}
          </div>
        </>
      ) : props.kind === "recording" ? (
        <Recorder onSave={upload} />
      ) : (
        <div className="media-upload">
          <input
            ref={input}
            type="file"
            hidden
            accept={
              audio
                ? "audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac"
                : ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"
            }
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file, file.name).catch((e: Error) => setError(e.message));
            }}
          />
          <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
            <Upload size={15} />
            {busy ? "Saving locally…" : audio ? "Upload audio" : "Upload document or image"}
          </Button>
          <small>
            {audio ? "WAV, MP3, M4A, WebM, Ogg or FLAC" : "PDF, PNG, JPEG, WebP or TIFF"} · up to
            200 MB
          </small>
        </div>
      )}
      {error && (
        <p role="alert" className="media-error">
          {error}
        </p>
      )}
    </div>
  );
}

export const LocalMedia = createReactBlockSpec(
  {
    type: "localMedia",
    propSchema: {
      file: { default: "" },
      name: { default: "" },
      kind: { default: "audio" },
      job: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <MediaView id={block.id} props={block.props} editor={editor as unknown as GraiteEditor} />
    ),
  },
);

function TextView({
  file,
  name,
  id,
  editor,
}: {
  file: string;
  name: string;
  id: string;
  editor: GraiteEditor;
}) {
  const { pageId } = useContext(MediaContext);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const { url } = useLocalFile(file);
  useEffect(() => {
    const controller = new AbortController();
    void media
      .blob(pageId, file, undefined, controller.signal)
      .then((b) => b.text())
      .then((t) => {
        if (!controller.signal.aborted) setText(t);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [pageId, file]);
  const rawBody = text.replace(/^# .*\n\nSource: .*\n\n/, "");
  const body = name.startsWith("Transcript") ? readableTranscript(rawBody) : rawBody;
  return (
    <div className="derived-text-block" contentEditable={false}>
      {body && (
        <button
          className="media-edit-text"
          onClick={() =>
            editor.replaceBlocks(
              [id],
              [
                {
                  type: "toggleListItem",
                  content: name,
                  children: toBlocks(body) as GraitePartialBlock[],
                },
              ],
            )
          }
        >
          Edit as toggle
        </button>
      )}
      <details>
        <summary>
          <FileText size={16} />
          <strong>{name}</strong>
          <span>Show text</span>
        </summary>
        <div className="derived-text-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ children }) => <span>{children}</span>,
              img: ({ alt }) => <span>{alt}</span>,
            }}
          >
            {body}
          </ReactMarkdown>
        </div>
      </details>
      <div className="derived-text-preview">
        {error || body.slice(0, 450) || "Opening Markdown…"}
      </div>
      {url && (
        <a className="media-text-download" href={url} download={`${name}.md`}>
          <Download size={13} /> Markdown file
        </a>
      )}
    </div>
  );
}
export const DerivedText = createReactBlockSpec(
  {
    type: "derivedText",
    propSchema: {
      file: { default: "" },
      name: { default: "" },
      source: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <TextView {...block.props} id={block.id} editor={editor as unknown as GraiteEditor} />
    ),
  },
);
