import EmojiPicker, { EmojiStyle, type EmojiClickData } from "emoji-picker-react";

/**
 * The page-icon picker body shared by the page header and the sidebar tree.
 * Emojis render as native text: the picker's default image sets load from a CDN,
 * which the app's CSP blocks, leaving the grid blank.
 */
export function EmojiPickerPanel({
  hasIcon,
  onPick,
  onRemove,
}: {
  hasIcon: boolean;
  onPick: (emoji: string) => void;
  onRemove: () => void;
}) {
  return (
    <div>
      {hasIcon && (
        <button
          className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
          onClick={onRemove}
        >
          Remove emoji
        </button>
      )}
      <EmojiPicker
        onEmojiClick={(d: EmojiClickData) => onPick(d.emoji)}
        emojiStyle={EmojiStyle.NATIVE}
        width={320}
        height={400}
        skinTonesDisabled
        searchPlaceHolder="Search emoji..."
        previewConfig={{ showPreview: false }}
      />
    </div>
  );
}
