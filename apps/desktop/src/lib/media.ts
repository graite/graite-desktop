import { request } from "./api";
import { platform } from "./platform";
import type { components } from "@graite/api-types";

export type Extraction = components["schemas"]["Extraction"];
export type Attachment = components["schemas"]["Attachment"];
export type AttachmentInfo = components["schemas"]["AttachmentInfo"];

/** Stored names carry a unique prefix; people only ever see the original name. */
export const displayName = (file: string) => file.replace(/^[a-f0-9]{32}-/, "") || file;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Save the original through the browser. Shared by the media block and the attachments list. */
export async function downloadAttachment(
  pageId: string,
  file: string,
  name: string,
): Promise<void> {
  const objectUrl = URL.createObjectURL(await media.blob(pageId, file));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** Open in the system's default app on desktop; elsewhere in a new tab, or as a download. */
export async function openAttachment(
  pageId: string,
  item: Pick<AttachmentInfo, "file" | "name" | "kind">,
): Promise<void> {
  if (platform.openPath) {
    const { path } = await media.location(pageId, item.file);
    return platform.openPath(path);
  }
  if (item.kind === "other" || item.kind === "text")
    return downloadAttachment(pageId, item.file, item.name);
  const objectUrl = URL.createObjectURL(await media.blob(pageId, item.file));
  window.open(objectUrl, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export const media = {
  attachments: (pageId: string) =>
    request<AttachmentInfo[]>(
      `/api/v1/media/attachments?${new URLSearchParams({ page_id: pageId })}`,
    ),
  /** Moves the file to the trash. A file still used on a page needs `force`; otherwise 409. */
  trashAttachment: (pageId: string, file: string, force = false) =>
    request<{ trash_id: string }>(
      `/api/v1/media/attachments?${new URLSearchParams({ page_id: pageId, file, force: String(force) })}`,
      { method: "DELETE" },
    ),
  move: (sourceId: string, targetPath: string, file: string, block: string, baseHash: string) =>
    request<{ path: string; source_hash: string }>("/api/v1/media/move", {
      method: "POST",
      body: JSON.stringify({
        source_id: sourceId,
        target_path: targetPath,
        file,
        block,
        base_hash: baseHash,
      }),
    }),
  location: (pageId: string, file: string) =>
    request<{ folder: string; path: string }>(
      `/api/v1/media/location?${new URLSearchParams({ page_id: pageId, file })}`,
    ),
  upload: (pageId: string, file: Blob, name: string) =>
    request<Attachment>(`/api/v1/media/upload?${new URLSearchParams({ page_id: pageId, name })}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
    }),
  extract: (pageId: string, file: string, name: string, output: "toggle" | "page") =>
    request<Extraction>("/api/v1/media/extract", {
      method: "POST",
      body: JSON.stringify({ page_id: pageId, file, name, output }),
    }),
  attachRecording: (pageId: string, file: string, name: string) =>
    request("/api/v1/media/attach-recording", {
      method: "POST",
      body: JSON.stringify({ page_id: pageId, file, name }),
    }),
  job: (id: string) => request<Extraction>(`/api/v1/media/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) =>
    request<Extraction>(`/api/v1/media/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  info: (pageId: string, file: string) =>
    request<{ pages: number }>(
      `/api/v1/media/info?${new URLSearchParams({ page_id: pageId, file })}`,
    ),
  async blob(pageId: string, file: string, preview?: number, signal?: AbortSignal): Promise<Blob> {
    const { url, token } = await platform.getDaemonInfo();
    const query = new URLSearchParams({ page_id: pageId, file });
    if (preview !== undefined) query.set("page", String(preview));
    const res = await fetch(
      `${url}/api/v1/media/${preview === undefined ? "file" : "preview"}?${query}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      },
    );
    if (!res.ok) {
      const error = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new Error(error.detail || "Could not open this local file.");
    }
    return res.blob();
  },
};
