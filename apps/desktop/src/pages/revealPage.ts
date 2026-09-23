import { toast } from "sonner";
import { pages } from "@/lib/api";
import { platform } from "@/lib/platform";

/** Only the desktop app can open a folder on this computer; the web build hides the action. */
export const canRevealPage = () => !!platform.revealFolder;

/** Open the folder holding the page's `page.md` in the system file manager. */
export async function revealPage(path: string): Promise<void> {
  try {
    const { folder } = await pages.location(path);
    await platform.revealFolder?.(folder);
  } catch (e) {
    toast.error(`Could not open the folder: ${(e as Error).message}`);
  }
}
