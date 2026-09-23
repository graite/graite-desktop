import { createReactBlockSpec } from "@blocknote/react";
/** The column bodies are normal child blocks in the same editor, not embedded editors. */
export const ColumnLayout = createReactBlockSpec(
  {
    type: "columnLayout",
    propSchema: { count: { default: 2, values: [2, 3, 4] as const } },
    content: "none",
  },
  {
    render: ({ block }) => (
      <div className="column-layout-label" contentEditable={false}>
        {block.props.count} columns
      </div>
    ),
  },
);
export const PageColumn = createReactBlockSpec(
  { type: "pageColumn", propSchema: {}, content: "none" },
  {
    render: () => <div className="page-column-label" contentEditable={false} />,
  },
);
