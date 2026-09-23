import { AlertCircle, FileText, ImageIcon, Loader2, Paperclip, X } from "lucide-react";
import type { Attachment } from "@/lib/ai";

const ICONS = { pdf: FileText, image: ImageIcon, text: Paperclip };

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="ai-chips">
      {attachments.map((a) => {
        const Icon = ICONS[a.kind as keyof typeof ICONS] ?? Paperclip;
        return (
          <span
            key={a.id}
            className="ai-chip"
            data-status={a.text_status}
            title={a.error ?? a.name}
          >
            <Icon size={12} />
            <span className="ai-chip-name">{a.name}</span>
            {a.text_status === "pending" && (
              <Loader2 size={11} className="ai-spin" aria-label="Reading" />
            )}
            {a.text_status === "failed" && <AlertCircle size={11} aria-label="Could not read" />}
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}>
              <X size={11} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
