import { createContext } from "react";
export const MediaContext = createContext<{
  pageId: string;
  pagePath?: string;
  navigate?: (path: string) => void;
  onTreeChanged: () => void;
  moveMedia?: (blockId: string, path: string) => Promise<void>;
}>({ pageId: "", onTreeChanged: () => {} });
