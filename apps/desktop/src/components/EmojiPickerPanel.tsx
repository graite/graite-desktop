import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";
import { useTheme } from "@/lib/theme";

/**
 * The emoji half of the page-icon picker.
 * Emojis render as native text: the picker's default image sets load from a CDN,
 * which the app's CSP blocks, leaving the grid blank.
 */
export function EmojiPickerPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const theme = useTheme();
  return (
    <EmojiPicker
      onEmojiClick={(d: EmojiClickData) => onPick(d.emoji)}
      emojiStyle={EmojiStyle.NATIVE}
      theme={theme === "dark" ? Theme.DARK : Theme.LIGHT}
      width={320}
      height={400}
      skinTonesDisabled
      searchPlaceHolder="Search emoji..."
      previewConfig={{ showPreview: false }}
    />
  );
}
