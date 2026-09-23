import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md rule 7: the UI reaches the host only through src/lib/platform/.
      // Convention: BlockNote is wrapped in src/editor/.
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@tauri-apps/api/core", message: "Use src/lib/platform/ instead." }],
          patterns: [{ group: ["@blocknote/*"], message: "BlockNote is only used inside src/editor/." }],
        },
      ],
    },
  },
  { files: ["src/lib/platform/**"], rules: { "no-restricted-imports": "off" } },
  { files: ["src/editor/**"], rules: { "no-restricted-imports": ["error", { paths: [{ name: "@tauri-apps/api/core", message: "Use src/lib/platform/ instead." }] }] } },
);
