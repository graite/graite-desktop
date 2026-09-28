import { createContext } from "react";
export const MediaContext = createContext<{
  pageId: string;
  pagePath?: string;
  navigate?: (path: string) => void;
  onTreeChanged: () => void;
  moveMedia?: (blockId: string, path: string) => Promise<void>;
  /** Move the page at `sourcePath` under the page at `targetPath`. */
  movePage?: (sourcePath: string, targetPath: string) => Promise<void>;
}>({ pageId: "", onTreeChanged: () => {} });
