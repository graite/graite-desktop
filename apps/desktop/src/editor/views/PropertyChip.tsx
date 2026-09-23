import { useEffect, useState } from "react";
import { Check, Paperclip } from "lucide-react";
import type { PageDoc } from "@/lib/api";
import { media } from "@/lib/media";
import type { PageProperty } from "@/lib/workspace";
import { PropertyTag } from "@/pages/PropertySelect";
import { formatDate } from "@/pages/DateField";
import { findField } from "./collection";

function Thumbnail({ page, file }: { page: PageDoc; file: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!/\.(png|jpe?g|webp)$/i.test(file)) {
      setUrl("");
      return;
    }
    let live = true;
    let object = "";
    void media
      .blob(page.id, file)
      .then((blob) => {
        if (live) {
          object = URL.createObjectURL(blob);
          setUrl(object);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [page.id, file]);
  return url ? (
    <img src={url} alt="" className="view-chip-thumb" draggable={false} />
  ) : (
    <span className="view-chip view-chip-text">
      <Paperclip size={11} />
      {file.replace(/^[a-f0-9]{32}-/, "")}
    </span>
  );
}

/** Compact, read-only rendering of one property value on a card or list row. */
export function PropertyChip({ page, field }: { page: PageDoc; field: PageProperty }) {
  const own = findField(page, field.name);
  if (field.type === "created" || field.type === "updated") {
    return (
      <span className="view-chip view-chip-text">
        {formatDate(String(page.frontmatter[field.type] ?? "").slice(0, 10))}
      </span>
    );
  }
  const value = own?.value;
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  )
    return null;
  const def = own ?? field;
  if (def.type === "checkbox")
    return value === true ? (
      <span className="view-chip view-chip-check">
        <Check size={11} /> {def.name}
      </span>
    ) : null;
  if (def.type === "status" || def.type === "single_select" || def.type === "multi_select") {
    return (
      <>
        {(Array.isArray(value) ? value : [String(value)]).map((o) => (
          <PropertyTag
            key={o}
            field={{ ...def, options: field.options, colors: { ...field.colors, ...def.colors } }}
            option={o}
          />
        ))}
      </>
    );
  }
  if (def.type === "media") return <Thumbnail page={page} file={String(value)} />;
  if (def.type === "date")
    return (
      <span className="view-chip view-chip-text" title={def.name}>
        {formatDate(String(value))}
      </span>
    );
  return (
    <span className="view-chip view-chip-text" title={def.name}>
      {String(value)}
    </span>
  );
}
