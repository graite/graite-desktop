import { platform } from "./platform";
import type { DaemonEvent } from "@graite/api-types";

export interface Health {
  status: string;
  version: string;
  pid: number;
  vault: string;
  vault_name: string;
  pages: number;
  /** Graite never indexed this folder before and it holds no pages yet. */
  is_new: boolean;
  serve: boolean;
  index: { vec_version: string };
  events: { subscribers: number };
}

export interface PageDoc {
  path: string;
  id: string;
  title: string;
  icon: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  hash: string;
}

export interface TreeNode {
  path: string;
  id: string;
  title: string;
  icon: string | null;
  has_content: boolean;
  /** The page holds a view (board, list, table); its children are that view's entries. */
  has_view?: boolean;
  children: TreeNode[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown by pages.put when the file on disk no longer matches `baseHash`. */
export class ConflictError extends ApiError {
  constructor(
    public hash: string,
    public body: string,
  ) {
    super(409, "changed on disk");
  }
}

/**
 * Ids of mutating requests this webview sent. The daemon echoes the id in the events the
 * write produces, so the workspace can tell its own saves from external changes without
 * racing the HTTP response. Ids linger for a grace period to catch late echoes.
 */
const ownRequests = new Set<string>();
const OWN_REQUEST_GRACE_MS = 2000;

export function isOwnRequest(id: string | null | undefined): boolean {
  return !!id && ownRequests.has(id);
}

export interface RequestOptions extends RequestInit {
  /**
   * Whether the write is this webview's own edit. Default true. Pass false for requests that
   * change pages on the user's behalf but not through the editor (applying a proposal), so
   * the resulting `file_changed` event reloads the open page instead of being ignored.
   */
  own?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { own = true, ...init } = options;
  const { url, token } = await platform.getDaemonInfo();
  const mutating = !!init.method && init.method !== "GET";
  const requestId = mutating && own ? crypto.randomUUID() : null;
  if (requestId) ownRequests.add(requestId);
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      ...(requestId ? { "X-Graite-Request": requestId } : {}),
      Authorization: `Bearer ${token}`,
    },
  }).finally(() => {
    if (requestId) setTimeout(() => ownRequests.delete(requestId), OWN_REQUEST_GRACE_MS);
  });
  if (res.status === 409) {
    const data = (await res.json()) as { hash?: string; body?: string; detail?: string };
    if (typeof data.hash === "string" && typeof data.body === "string") {
      throw new ConflictError(data.hash, data.body);
    }
    throw new ApiError(409, data.detail || "Another operation is in progress.");
  }
  if (!res.ok) {
    let detail = `${init.method ?? "GET"} ${path} -> ${res.status}`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === "string") detail = data.detail;
      else if (Array.isArray(data.detail)) {
        detail = data.detail
          .map((item: { msg?: string }) => item.msg || "Invalid setting")
          .join(" · ");
      }
    } catch {
      /* no body */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const api = {
  health: () => request<Health>("/api/v1/health"),
};

export interface TrashEntry {
  trash_id: string;
  path: string | null;
  title: string;
  trashed_at: string;
  /** An attachment entry is one file; `path` is then the page it belonged to. */
  kind: "page" | "attachment";
  file: string | null;
  page_id: string | null;
  size: number;
}

export interface PurgeResult {
  entries: number;
  bytes: number;
}

export const trash = {
  list: () => request<TrashEntry[]>("/api/v1/trash"),
  /** Permanently delete one entry. */
  purge: (trashId: string) =>
    request<PurgeResult>(`/api/v1/trash/${encodeURIComponent(trashId)}`, { method: "DELETE" }),
  /** Permanently delete everything in the trash. */
  empty: () => request<PurgeResult>("/api/v1/trash", { method: "DELETE" }),
  restore: (trashId: string) =>
    request<PageDoc>(`/api/v1/trash/${encodeURIComponent(trashId)}/restore`, {
      method: "POST",
      ...json({}),
    }),
};

export const pages = {
  tree: () => request<TreeNode[]>("/api/v1/vault/tree"),
  get: (path: string) => request<PageDoc>(`/api/v1/pages/${enc(path)}`),
  put: (path: string, body: string, baseHash: string | null) =>
    request<{ hash: string }>(`/api/v1/pages/${enc(path)}`, {
      method: "PUT",
      ...json({ body, base_hash: baseHash }),
    }),
  patch: (path: string, patch: { title?: string; icon?: string | null }) =>
    request<PageDoc>(`/api/v1/pages/${enc(path)}`, { method: "PATCH", ...json(patch) }),
  create: (opts: { parentPath?: string | null; title?: string; icon?: string | null }) =>
    request<PageDoc>("/api/v1/pages", {
      method: "POST",
      ...json({
        parent_path: opts.parentPath ?? null,
        title: opts.title ?? "Untitled",
        icon: opts.icon ?? null,
      }),
    }),
  remove: (path: string) =>
    request<{ trash_id: string }>(`/api/v1/pages/${enc(path)}`, { method: "DELETE" }),
  /** Absolute folder and page.md on the daemon's machine. */
  location: (path: string) =>
    request<{ folder: string; file: string }>(
      `/api/v1/vault/location?path=${encodeURIComponent(path)}`,
    ),
  resolveLink: (path: string, target: string) =>
    request<{ path: string }>(`/api/v1/pages/${enc(path)}/resolve-link`, {
      method: "POST",
      ...json({ target }),
    }),
  instructions: {
    get: (source: string) =>
      request<{ source: string; text: string; hash: string }>(
        `/api/v1/vault/instructions?source=${encodeURIComponent(source)}`,
      ),
    put: (source: string, text: string, base_hash: string) =>
      request<{ source: string; text: string; hash: string }>(
        `/api/v1/vault/instructions?source=${encodeURIComponent(source)}`,
        { method: "PUT", ...json({ text, base_hash }) },
      ),
  },
  aiSettings: {
    get: (path: string) => request<AiSettings>(`/api/v1/pages/${enc(path)}/ai-settings`),
    put: (path: string, values: Record<string, unknown>, baseHash: string | null) =>
      request<AiSettings>(`/api/v1/pages/${enc(path)}/ai-settings`, {
        method: "PUT",
        ...json({ values, base_hash: baseHash }),
      }),
  },
};

export type FeedbackKind = "bug" | "idea" | "other";

/** Feedback to the Graite developers, sent by the daemon only when the user presses Send. */
export const feedback = {
  status: () => request<{ enabled: boolean }>("/api/v1/feedback"),
  send: (body: { kind: FeedbackKind; message: string; email?: string; include_log: boolean }) =>
    request<{ sent: boolean }>("/api/v1/feedback", { method: "POST", ...json(body) }),
};

/** Per-page AI settings and the values inherited from ancestors (docs/vault-format.md §2). */
export interface AiSettings {
  own: Record<string, unknown>;
  effective: {
    values: Record<string, unknown>;
    sources: Record<string, string>;
    instructions: { source: string; text: string }[];
    /** Every file that set something, root first: {source, values}. */
    layers?: { source: string; values: Record<string, unknown> }[];
  };
  inherited?: AiSettings["effective"];
  page: PageDoc | null;
}

const eventListeners = new Set<(e: DaemonEvent) => void>();

/** Listen to the events of the socket opened by `connectEvents` without opening another one. */
export function onDaemonEvent(listener: (e: DaemonEvent) => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/** Subscribe to the daemon's event stream. Returns a disposer. Reconnects with backoff. */
export function connectEvents(onEvent: (e: DaemonEvent) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let delay = 500;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reconnect = () => {
    if (closed) return;
    retry = setTimeout(() => void open(), delay);
    delay = Math.min(delay * 2, 10_000);
  };

  const open = async () => {
    let info;
    try {
      info = await platform.getDaemonInfo();
    } catch {
      reconnect();
      return;
    }
    // Startup is asynchronous; the subscriber may unmount before the service is ready.
    if (closed) return;
    const { url, token } = info;
    const wsUrl = url.replace(/^http/, "ws") + `/events?token=${encodeURIComponent(token)}`;
    socket = new WebSocket(wsUrl);
    socket.onopen = () => (delay = 500);
    socket.onmessage = (m) => {
      const event = JSON.parse(m.data as string) as DaemonEvent;
      onEvent(event);
      for (const listener of eventListeners) listener(event);
    };
    socket.onclose = reconnect;
  };
  void open();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}
