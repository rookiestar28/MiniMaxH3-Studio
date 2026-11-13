import { describe, expect, it, vi } from "vitest";

import {
  captureGraphWriteAuthority,
  probeGraphWriter,
  probeWorkflowStore,
  writeValidatedGraph,
} from "../src/host/canvasOwnedWrite";

describe("owned canvas write seam", () => {
  it("passes the captured active workflow as the fourth write argument", async () => {
    const workflow = {};
    const loadGraphData = vi.fn();
    const beginConfigure = vi.fn(() => vi.fn());
    const hostApp = {
      extensionManager: {
        workflow: { activeWorkflow: workflow, openWorkflows: [workflow] },
      },
      loadGraphData,
    };
    const pending = captureGraphWriteAuthority(hostApp, beginConfigure);
    const authority = await writeValidatedGraph(
      hostApp,
      { nodes: [], links: [] },
      pending,
    );
    expect(authority.workflow).toBe(workflow);
    expect(loadGraphData).toHaveBeenCalledWith(
      { nodes: [], links: [] },
      true,
      true,
      workflow,
    );
    expect(beginConfigure).toHaveBeenCalledOnce();
  });

  it("names missing workflow and writer seams without invoking them", () => {
    expect(probeWorkflowStore({})).toEqual({
      status: "unavailable",
      reason: "workflow_store_unavailable",
    });
    expect(probeGraphWriter({})).toEqual({
      status: "unavailable",
      reason: "load_graph_data_unavailable",
    });
  });
});

describe("closed compile diagnostic origin", () => {
  it("distinguishes the tabless root-write bootstrap refusal", async () => {
    const hostApp = {
      extensionManager: {
        workflow: { activeWorkflow: null, openWorkflows: [] },
      },
      loadGraphData: vi.fn(() => {
        throw new Error("synthetic bootstrap refusal");
      }),
    };
    const release = vi.fn();
    const pending = captureGraphWriteAuthority(hostApp, () => release);
    await expect(
      writeValidatedGraph(hostApp, { nodes: [], links: [] }, pending),
    ).rejects.toMatchObject({
      code: "compile_failed",
      compileStep: "root_write_bootstrap",
      message:
        "compile_failed: the host rejected the validated graph transaction",
    });
    expect(hostApp.loadGraphData).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
