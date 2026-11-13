// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import "../helpers/radix-jsdom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { PaTransportProvider } from "../../../src/fantay/pa/pa-transport";
import { createFixtureTransport } from "../../../src/fantay/pa/lab/fixture-transport";
import { buildFixture, PA_SCENARIO_IDS, type PaScenarioId } from "../../../src/fantay/pa/lab/fixtures";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function mount(id: PaScenarioId) {
  const fixture = buildFixture(id);
  return render(
    <I18nProvider initial="en">
      <PaTransportProvider transport={createFixtureTransport(fixture, { latency: 0 })}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={fixture.ui} />
      </PaTransportProvider>
    </I18nProvider>,
  );
}

describe("pa-lab fixtures", () => {
  it("defines every scenario with the contract shape", () => {
    for (const id of PA_SCENARIO_IDS) {
      const f = buildFixture(id);
      expect(Array.isArray(f.snapshot.agents)).toBe(true);
      expect(Array.isArray(f.channels.channels)).toBe(true);
      expect(typeof f.control.paused).toBe("boolean");
    }
  });
  it("first-run shows the empty Fantay conversation", async () => {
    mount("first-run");
    expect(await screen.findByTestId("pa-empty-chat")).toBeTruthy();
  });
  it("fantay-chat shows the working line", async () => {
    mount("fantay-chat");
    expect(await screen.findByTestId("pa-work-line")).toBeTruthy();
  });
  it("needs-you shows at least three needs-you cards", async () => {
    mount("needs-you");
    await waitFor(() => expect(screen.getAllByTestId("pa-needs-card").length).toBeGreaterThanOrEqual(3));
  });
  it("project-done shows the result card", async () => {
    mount("project-done");
    expect(await screen.findByTestId("pa-result-card")).toBeTruthy();
  });
  it("connections shows the connections page", async () => {
    mount("connections");
    expect(await screen.findByTestId("pa-connections")).toBeTruthy();
  });
  it("offline says the local service is unreachable", async () => {
    mount("offline");
    expect(await screen.findByText(/Can't reach the local Fantay service/)).toBeTruthy();
  });
});
