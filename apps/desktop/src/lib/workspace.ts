import { request, type PageDoc } from "./api";
export const propertyTypes = {
  text: "Text",
  number: "Number",
  single_select: "Single select",
  multi_select: "Multi select",
  date: "Date",
  checkbox: "Checkbox",
  email: "Email",
  url: "URL",
  media: "Media / image",
  status: "Status",
  created: "Created at",
  updated: "Last updated at",
} as const;
export type PropertyKind = keyof typeof propertyTypes;
export type PageProperty = {
  id: string;
  name: string;
  type: PropertyKind;
  options: string[];
  colors?: Record<string, string>;
  value: string | string[] | boolean | number | null;
};
export function pageProperties(page: PageDoc): PageProperty[] {
  return Array.isArray(page.frontmatter.properties)
    ? (page.frontmatter.properties as PageProperty[])
    : [];
}
export const workspace = {
  children: (pageId: string) =>
    request<PageDoc[]>(`/api/v1/workspace/children?${new URLSearchParams({ page_id: pageId })}`),
  properties: (pageId: string, properties: PageProperty[], hash: string) =>
    request<PageDoc>("/api/v1/workspace/properties", {
      method: "PUT",
      body: JSON.stringify({ page_id: pageId, properties, base_hash: hash }),
    }),
  move: (pageId: string, targetId: string | null, position: "before" | "after" | "inside") =>
    request<PageDoc>("/api/v1/workspace/move", {
      method: "POST",
      body: JSON.stringify({ page_id: pageId, target_id: targetId, position }),
    }),
};
