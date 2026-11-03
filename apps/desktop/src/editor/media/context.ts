import { createContext } from "react";
export const MediaContext = createContext<{
  pageId: string;
  pagePath?: string;
  navigate?: (path: string) => void;
  onTreeChanged: () => void;
  moveMedia?: (blockId: string, path: string) => Promise<void>;
  /** Open a table row as a full page (D80). */
  openRow?: (table: string, id: string) => void;
  /** Move the page at `sourcePath` under the page at `targetPath`. */
  movePage?: (sourcePath: string, targetPath: string) => Promise<void>;
}>({ pageId: "", onTreeChanged: () => {} });
