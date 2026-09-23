import { useEffect, useRef, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { fromBlocks, toBlocks } from "@graite/md-convert";
import type { TreeNode } from "@/lib/api";
import { schema, type GraitePartialBlock } from "./schema";
import { EditorSurface } from "./EditorSurface";
import { PagePicker } from "./PagePicker";
import { resolveTarget, type FlatPage } from "./tree-utils";
import type { PickedPage } from "./slash-menu";
import { useSelectAllStages } from "./useSelectAllStages";
import { markdownPasteHandler } from "./paste";

function hydrate(blocks: GraitePartialBlock[], tree: TreeNode[]): GraitePartialBlock[] {
  return blocks.map((block) => {
    if (block.type === "pageLink" && block.props) {
      const target = block.props.target || block.props.path || block.props.title || "";
      const page = resolveTarget(tree, "", target);
      if (page)
        return {
          ...block,
          props: {
            ...block.props,
            path: page.path,
            title: page.title,
            icon: page.icon ?? "",
            target,
          },
        };
    }
    return block.children?.length
      ? { ...block, children: hydrate(block.children as GraitePartialBlock[], tree) }
      : block;
  });
}

function instructionBlocks(value: string, tree: TreeNode[]): GraitePartialBlock[] {
  const blocks = hydrate(toBlocks(value) as GraitePartialBlock[], tree);
  return blocks.length ? blocks : [{ type: "paragraph" }];
}

/** The same block schema, Markdown converter and editing surface as a knowledge page. */
export function AgentInstructionsEditor({
  value,
  onChange,
  tree,
  onNavigate,
}: {
  value: string;
  onChange: (value: string) => void;
  tree: TreeNode[];
  onNavigate: (path: string) => void;
}) {
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const [pasteHandler] = useState(() =>
    markdownPasteHandler((blocks) => hydrate(blocks, treeRef.current)),
  );
  const editor = useCreateBlockNote({
    schema,
    initialContent: instructionBlocks(value, tree),
    pasteHandler,
  });
  useSelectAllStages(editor);
  const last = useRef(value);
  const syncing = useRef(false);
  const [picker, setPicker] = useState(false);
  const pickResolve = useRef<((page: PickedPage | null) => void) | null>(null);
  useEffect(() => {
    if (value === last.current) return;
    syncing.current = true;
    editor.replaceBlocks(editor.document, instructionBlocks(value, tree));
    last.current = value;
    syncing.current = false;
  }, [value, editor]);
  useEffect(
    () => () => {
      pickResolve.current?.(null);
    },
    [],
  );
  const pick = (page: FlatPage | null) => {
    const selected = page ? { ...page, target: page.path } : null;
    if (pickResolve.current) {
      pickResolve.current(selected);
      pickResolve.current = null;
    }
    setPicker(false);
  };
  return (
    <div
      className="agent-instructions"
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest<HTMLElement>(
          "[data-page-link], [data-wikilink]",
        );
        if (!link) return;
        const target =
          link.dataset.pagePath || link.dataset.wikilinkTarget || link.textContent || "";
        const page = resolveTarget(tree, "", target);
        if (page) onNavigate(page.path);
      }}
    >
      <div className="agent-editor-tools">
        <span>Use / for blocks and page links</span>
      </div>
      <EditorSurface
        editor={editor}
        instructionsOnly
        slashDeps={{
          createChildPage: async () => {
            throw new Error("Create knowledge pages from the sidebar.");
          },
          onTreeChanged: () => {},
          pickPage: () =>
            new Promise((resolve) => {
              pickResolve.current = resolve;
              setPicker(true);
            }),
        }}
        onChange={() => {
          if (syncing.current) return;
          const next = fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]);
          last.current = next;
          onChange(next);
        }}
      />
      <PagePicker
        open={picker}
        tree={tree}
        excludePath={null}
        onPick={pick}
        onCancel={() => pick(null)}
      />
    </div>
  );
}
