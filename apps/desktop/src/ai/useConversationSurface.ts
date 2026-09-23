import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ai, type AIStatus, type Attachment, type Conversation } from "@/lib/ai";
import { onDaemonEvent } from "@/lib/api";

/** Whether the saved AI configuration can answer at all (a model and, if needed, a key). */
export function isConfigured(status: AIStatus): boolean {
  const c = status.config;
  return c.provider === "local"
    ? !!c.model_path && !!(c.binary_path || status.hardware.binary_path)
    : !!c.model && (c.provider !== "anthropic" || status.key_saved);
}

/** Pending uploads for the next question, shared by the Studio and the page panel. */
export function useAttachments(
  selected: Conversation | null,
  ensureConversation: () => Promise<Conversation>,
) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type !== "attachment_update") return;
        const data = event.data as { id: string; text_status: string; error?: string | null };
        setAttachments((old) =>
          old.map((a) =>
            a.id === data.id
              ? { ...a, text_status: data.text_status, error: data.error ?? null }
              : a,
          ),
        );
      }),
    [],
  );

  const attach = useCallback(
    async (files: FileList | File[]) => {
      let conversation = selected;
      try {
        conversation ??= await ensureConversation();
        for (const file of Array.from(files)) {
          const uploaded = await ai.uploadAttachment(conversation.id, file, file.name);
          setAttachments((old) => [...old, uploaded]);
        }
      } catch (e) {
        toast.error(`Could not attach: ${(e as Error).message}`);
      }
    },
    [selected, ensureConversation],
  );

  const remove = useCallback(
    async (id: string) => {
      setAttachments((old) => old.filter((a) => a.id !== id));
      if (selected) await ai.deleteAttachment(selected.id, id).catch(() => {});
    },
    [selected],
  );

  /** Ids worth sending with the next question; clears the pending list. */
  const take = useCallback(() => {
    const ids = attachments.filter((a) => a.text_status !== "failed").map((a) => a.id);
    setAttachments([]);
    return ids;
  }, [attachments]);

  return { attachments, setAttachments, attach, remove, take };
}
