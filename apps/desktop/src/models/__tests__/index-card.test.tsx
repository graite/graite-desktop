import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const aiMock = vi.hoisted(() => ({ indexStatus: vi.fn(), rebuildIndex: vi.fn() }));
const apiMock = vi.hoisted(() => ({ request: vi.fn(), onDaemonEvent: vi.fn(() => () => {}) }));
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, ai: aiMock };
});
vi.mock("@/lib/api", () => apiMock);

import { IndexCard } from "../IndexCard";
import type { AIConfig } from "@/lib/ai";

const config = { embedding_model_id: "" } as AIConfig;

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.request.mockResolvedValue([
    { id: "gemma", name: "EmbeddingGemma", role: "embedding", status: "installed" },
  ]);
});
afterEach(cleanup);

it("reports what is searchable and starts a rebuild", async () => {
  aiMock.indexStatus.mockResolvedValue({
    pages: 12,
    chunks: 18,
    pending_chunks: 0,
    embedding_model: "gemma",
    worker: "idle",
  });
  aiMock.rebuildIndex.mockResolvedValue({ job_id: "j" });
  render(<IndexCard config={config} onPatch={vi.fn()} disabled={false} />);
  await screen.findByText("18 sections from 12 pages are searchable.");
  fireEvent.click(screen.getByRole("button", { name: /Rebuild index/ }));
  await waitFor(() => expect(aiMock.rebuildIndex).toHaveBeenCalled());
});

it("says when only keyword search is available", async () => {
  aiMock.indexStatus.mockResolvedValue({
    pages: 12,
    chunks: 18,
    pending_chunks: 18,
    embedding_model: null,
    worker: "idle",
  });
  apiMock.request.mockResolvedValue([]);
  render(<IndexCard config={config} onPatch={vi.fn()} disabled={false} />);
  await screen.findByText(/Keyword search only/);
  expect(screen.getByText("No search model installed")).toBeTruthy();
});

it("shows indexing progress while it runs", async () => {
  aiMock.indexStatus.mockResolvedValue({
    pages: 12,
    chunks: 18,
    pending_chunks: 5,
    embedding_model: "gemma",
    worker: "indexing",
  });
  render(<IndexCard config={config} onPatch={vi.fn()} disabled={false} />);
  await screen.findByText("Indexing 5 of 18 sections…");
  expect(screen.getByText("Working")).toBeTruthy();
});
