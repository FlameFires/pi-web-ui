// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SessionChangedFiles } from "../../web/src/components/SessionChangedFiles";
import { LanguageProvider } from "../../web/src/i18n";
import type {
	ClientMessage,
	SessionFileLedgerFile,
	SessionFileLedgerOperation,
	SessionFileLedgerPage,
	UiState,
} from "../../web/src/types";
import { registerFilePreviewHost } from "../../web/src/file-preview-bridge";
import { setAppSend } from "../../web/src/app-globals";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
type LedgerRequest = Extract<ClientMessage, { type: "session_file_ledger" }>;
let requests: LedgerRequest[] = [];
const file: SessionFileLedgerFile = { path: "docs/a.md", kind: "file", status: "present", operationCount: 1 };
const operation: SessionFileLedgerOperation = {
	id: "t1",
	toolName: "write",
	label: "created",
	argumentsText: JSON.stringify({ path: file.path, content: "# Sample" }),
	output: "written",
};
const messages: UiState["messages"] = [
	{
		id: "a",
		role: "assistant",
		content: [{ type: "toolCall", id: operation.id, name: operation.toolName, argumentsText: operation.argumentsText }],
	},
	{
		id: "r",
		role: "toolResult",
		toolCallId: operation.id,
		toolName: operation.toolName,
		content: [{ type: "text", text: operation.output }],
	},
];
function render(sessionId = "one", historyStart = 0, items: UiState["messages"] = []) {
	const state = {
		sessionId,
		conversationId: sessionId,
		sessionFile: `/sessions/${sessionId}.jsonl`,
		cwd: "/repo",
		messages: items,
		historyStart,
	} as UiState;
	act(() => root.render(createElement(LanguageProvider, { children: createElement(SessionChangedFiles, { state }) })));
}
function reply(request: LedgerRequest, values: Partial<SessionFileLedgerPage> = {}) {
	const page: SessionFileLedgerPage = {
		conversationId: request.conversationId,
		sessionFile: request.sessionFile,
		cwd: request.cwd,
		reqId: request.reqId,
		path: request.path,
		files: request.path ? [] : [file],
		operations: request.path ? [operation] : [],
		coverage: "available-transcript",
		cumulative: { status: "unavailable", reason: "Historical evidence has no full baseline" },
		...values,
	};
	act(() => window.dispatchEvent(new CustomEvent("pi:session_file_ledger_page", { detail: page })));
}
function latestRequest() {
	return requests[requests.length - 1];
}
beforeEach(() => {
	requests = [];
	setAppSend((message) => {
		if (message.type === "session_file_ledger") requests.push(message);
		return true;
	});
});
afterEach(() => {
	act(() => root.unmount());
	root = createRoot(container);
	registerFilePreviewHost(null);
	setAppSend(() => false);
});
function click(selector: string) {
	const target = document.querySelector<HTMLElement>(selector);
	expect(target, `Missing clickable element: ${selector}`).not.toBeNull();
	act(() => target!.click());
}
it("opens the persisted file list, loads operation details and opens the current file", () => {
	const open = vi.fn();
	registerFilePreviewHost({ open });
	render();
	expect(document.querySelector(".session-files-panel")).toBeNull();
	expect(requests).toHaveLength(0);
	click(".session-files-trigger");
	expect(latestRequest()).toMatchObject({ conversationId: "one", sessionFile: "/sessions/one.jsonl", cwd: "/repo" });
	reply(latestRequest());
	expect(document.querySelector("summary")?.textContent).toContain(file.path);
	click("summary");
	expect(latestRequest().path).toBe(file.path);
	reply(latestRequest());
	expect(document.querySelector(".session-files-detail")?.textContent).toContain("Sample");
	click(".session-files-preview");
	expect(open).toHaveBeenCalledWith({ path: file.path, name: "a.md" });
	expect(document.querySelector(".session-files-panel")).toBeNull();
});
it("closes on session switch and rejects persisted pages from the previous conversation", () => {
	render();
	click(".session-files-trigger");
	const previous = latestRequest();
	reply(previous);
	render("two");
	expect(document.querySelector(".session-files-panel")).toBeNull();
	click(".session-files-trigger");
	reply(previous);
	expect(document.querySelector("summary")).toBeNull();
	expect(latestRequest().sessionFile).toBe("/sessions/two.jsonl");
	reply(latestRequest(), { files: [] });
	expect(document.querySelector(".session-files-empty")).not.toBeNull();
});
it("pages persisted files independently of loaded chat history and reports ledger coverage", () => {
	render("one", 40);
	click(".session-files-trigger");
	reply(latestRequest(), { nextCursor: "files-page-2", coverage: "recorded-only" });
	expect(document.querySelectorAll(".session-files-note")).toHaveLength(2);
	expect(document.querySelector("summary")?.textContent).toContain(file.path);
	const count = requests.length;
	render("one", 0, messages);
	expect(requests).toHaveLength(count);
	expect(document.querySelectorAll(".session-files-note")).toHaveLength(2);
	const next = [...document.querySelectorAll<HTMLButtonElement>(".session-files-panel > button")].find(
		(button) => button.textContent === "Next page",
	);
	expect(next).toBeDefined();
	act(() => next!.click());
	expect(latestRequest().cursor).toBe("files-page-2");
	reply(latestRequest(), { files: [{ ...file, path: "docs/second.md" }], coverage: "available-transcript" });
	expect(document.querySelector("summary")?.textContent).toContain("docs/second.md");
	expect(document.querySelector("summary")?.textContent).not.toContain(file.path);
	expect(document.querySelectorAll(".session-files-note")).toHaveLength(1);
	render("one", 80);
	expect(requests).toHaveLength(count + 1);
	expect(document.querySelector("summary")?.textContent).toContain("docs/second.md");
});
it("closes with Escape and restores focus to the entry", () => {
	render();
	click(".session-files-trigger");
	reply(latestRequest());
	act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(document.querySelector(".session-files-panel")).toBeNull();
	expect(document.activeElement).toBe(container.querySelector("button"));
});
it("shows a persisted deleted file as historical-only and hides its current preview action", () => {
	render();
	click(".session-files-trigger");
	reply(latestRequest(), { files: [{ ...file, status: "deleted", operationCount: 2 }] });
	click("summary");
	reply(latestRequest(), {
		operations: [operation, { id: "t2", toolName: "bash", label: "deleted", output: "removed" }],
	});
	expect(document.querySelector(".session-files-state")?.textContent).toContain("Deleted");
	expect(document.querySelector(".session-files-preview")).toBeNull();
	expect(document.querySelector(".session-files-detail")?.textContent).toContain("Sample");
	expect(document.querySelector(".session-files-detail")?.textContent).toContain("removed");
});
