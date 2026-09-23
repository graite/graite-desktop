import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { ColumnLayout, PageColumn } from "./blocks/ColumnsBlock";
import { PageView } from "./blocks/PageViewBlock";
import { LocalMedia, DerivedText } from "./blocks/MediaBlock";
import { PageLink } from "./blocks/PageLinkBlock";
import { Wikilink } from "./blocks/WikilinkInline";
import { RawMarkdown } from "./blocks/RawMarkdownBlock";

// Local audio/documents use Graite blocks with authenticated vault attachments.
// Keep the unmapped generic file/video blocks out of the slash menu.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { audio: _audio, video: _video, file: _file, ...mappedBlockSpecs } = defaultBlockSpecs;

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...mappedBlockSpecs,
    columnLayout: ColumnLayout(),
    pageColumn: PageColumn(),
    pageView: PageView(),
    pageLink: PageLink(),
    localMedia: LocalMedia(),
    derivedText: DerivedText(),
    rawMarkdown: RawMarkdown(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: Wikilink,
  },
});

export type GraiteEditor = typeof schema.BlockNoteEditor;
export type GraiteBlock = typeof schema.Block;
export type GraitePartialBlock = typeof schema.PartialBlock;
