import { request } from "./api";
import type { components } from "@graite/api-types";

export type ComputeStatus = components["schemas"]["ComputeStatus"];
export type ComputeDevice = components["schemas"]["ComputeDevice"];
/** The kinds of AI work another computer can do: chat, documents, speech, voice. */
export type ComputeTask = ComputeDevice["uses"][number];
type AIConfig = components["schemas"]["AIConfig"];

/** AI on another of your own computers (a local AI workstation), reached through the sync
 * connection. */
export const compute = {
  status: () => request<ComputeStatus>("/api/v1/compute/status"),
  /** Let your other devices use this computer's local models, or stop that. */
  serve: (on: boolean) =>
    request<ComputeStatus>("/api/v1/compute/serve", {
      method: "PUT",
      body: JSON.stringify({ on }),
    }),
  /** Do one kind of AI work on that device, or (`on` false) take it back. For chat, `model`
   * names which of its models; without it the device answers with the one it uses itself. */
  use: (deviceId: string, what: ComputeTask, on: boolean, model?: string) =>
    request<AIConfig>("/api/v1/compute/use", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, what, on, model }),
    }),
};
