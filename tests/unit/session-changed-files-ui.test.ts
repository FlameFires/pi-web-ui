// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SessionChangedFiles } from "../../web/src/components/SessionChangedFiles";
import { LanguageProvider } from "../../web/src/i18n";
import type { UiState } from "../../web/src/types";
import { registerFilePreviewHost } from "../../web/src/file-preview-bridge";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
const messages: UiState["messages"] = [
	{
		id: "a",
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "t1",
				name: "write",
				argumentsText: JSON.stringify({ path: "docs/a.md", content: "# Sample" }),
			},
		],
	},
	{ id: "r", role: "toolResult", toolCallId: "t1", toolName: "write", content: [{ type: "text", text: "written" }] },
];
function render(sessionId = "one", historyStart = 0, items = messages) {
	const state = { sessionId, cwd: "/repo", messages: items, historyStart } as UiState;
	act(() => root.render(createElement(LanguageProvider, { children: createElement(SessionChangedFiles, { state }) })));
}
afterEach(() => {
	act(() => root.unmount());
	root = createRoot(container);
	registerFilePreviewHost(null);
});
function click(selector: string) {
	act(() => {
		document.querySelector<HTMLElement>(selector)!.click();
	});
}
it("opens the file list, shows historical content and opens the current file", () => {
	const open = vi.fn();
	registerFilePreviewHost({ open });
	render();
	expect(container.textContent).toContain("1");
	click(".session-files-trigger");
	expect(document.querySelector(".session-files-panel")).not.toBeNull();
	expect(document.querySelector("summary")?.textContent).toContain("docs/a.md");
	click("summary");
	expect(document.querySelector(".session-files-detail")?.textContent).toContain("Sample");
	click(".session-files-detail > button");
	expect(open).toHaveBeenCalledWith({ path: "docs/a.md", name: "a.md" });
	expect(document.querySelector(".session-files-panel")).toBeNull();
});
it("closes on session switch and does not show files from the previous conversation", () => {
	render();
	click(".session-files-trigger");
	render("two", 0, []);
	expect(document.querySelector(".session-files-panel")).toBeNull();
	click(".session-files-trigger");
	expect(document.querySelector("summary")).toBeNull();
	expect(document.querySelector(".session-files-empty")).not.toBeNull();
});
it("discloses missing history and updates when earlier messages load", () => {
	render("one", 40, []);
	click(".session-files-trigger");
	expect(document.querySelectorAll(".session-files-note")).toHaveLength(2);
	render();
	expect(document.querySelectorAll(".session-files-note")).toHaveLength(1);
	expect(document.querySelector("summary")?.textContent).toContain("docs/a.md");
});
it("closes with Escape and restores focus to the entry", () => {
	render();
	click(".session-files-trigger");
	act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(document.querySelector(".session-files-panel")).toBeNull();
	expect(document.activeElement).toBe(container.querySelector("button"));
});
