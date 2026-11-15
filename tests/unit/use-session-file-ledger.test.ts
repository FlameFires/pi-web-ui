// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setAppSend } from "../../web/src/app-globals";
import { useSessionFileLedger } from "../../web/src/use-session-file-ledger";
import type { ClientMessage, SessionFileLedgerPage, UiState } from "../../server/protocol";

let root: Root | undefined;
let hook: ReturnType<typeof useSessionFileLedger>;
let requests: Extract<ClientMessage, { type: "session_file_ledger" }>[];
const state = (sessionFile = "/sessions/one.jsonl") =>
	({ conversationId: "c1", sessionFile, cwd: "/repo", messages: [], sessionId: sessionFile }) as unknown as UiState;
function Harness({ value, open }: { value: UiState; open: boolean }) {
	hook = useSessionFileLedger(value, open);
	return null;
}
function mount(value: UiState, open = true) {
	if (!root) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	}
	act(() => root!.render(createElement(Harness, { value, open })));
}
function receive(request: (typeof requests)[number], overrides: Partial<SessionFileLedgerPage> = {}) {
	act(() =>
		window.dispatchEvent(
			new CustomEvent("pi:session_file_ledger_page", {
				detail: {
					...request,
					type: "session_file_ledger_page",
					files: [{ path: "a", kind: "file", status: "present", operationCount: 1 }],
					operations: [],
					coverage: "available-transcript",
					cumulative: { status: "unavailable", reason: "no evidence" },
					...overrides,
				},
			}),
		),
	);
}
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
});
function setup() {
	requests = [];
	setAppSend((message) => {
		if (message.type === "session_file_ledger") requests.push(message);
		return true;
	});
}

describe("use-session-file-ledger", () => {
	it("does not read when closed and does not reread when chat history pages or tokens change", () => {
		setup();
		const value = state();
		mount(value, false);
		expect(requests).toHaveLength(0);
		mount(value);
		expect(requests).toHaveLength(1);
		receive(requests[0]);
		mount({ ...value, messages: [{ id: "older", role: "assistant", content: [] }], historyStart: 0 });
		expect(requests).toHaveLength(1);
		expect(hook.page?.files[0].path).toBe("a");
	});
	it("rejects late replies after switching sessions even when conversation id is reused", () => {
		setup();
		mount(state());
		const old = requests[0];
		mount(state("/sessions/two.jsonl"));
		receive(old);
		expect(hook.page).toBeNull();
		receive(requests[1]);
		expect(hook.page?.sessionFile).toBe("/sessions/two.jsonl");
	});
	it("deduplicates inflight pages, retains current cursor on change, and discards superseded request ids", () => {
		setup();
		mount(state());
		receive(requests[0], { nextCursor: "next" });
		act(() => {
			hook.request(undefined, "next");
			hook.request(undefined, "next");
		});
		expect(requests).toHaveLength(2);
		receive(requests[1]);
		act(() => window.dispatchEvent(new CustomEvent("pi:session_file_ledger_changed", { detail: requests[1] })));
		expect(requests[2].cursor).toBe("next");
		receive(requests[1], { files: [] });
		expect(hook.busy).toBe(true);
		receive(requests[2]);
		expect(hook.busy).toBe(false);
	});
	it("times out requests, permits retries and removes listeners on close", () => {
		vi.useFakeTimers();
		setup();
		mount(state());
		act(() => vi.advanceTimersByTime(20001));
		expect(hook.error).toContain("timed out");
		expect(hook.busy).toBe(false);
		act(() => hook.request());
		expect(requests).toHaveLength(2);
		mount(state(), false);
		receive(requests[1]);
		expect(hook.page).toBeNull();
		act(() => window.dispatchEvent(new CustomEvent("pi:session_file_ledger_changed", { detail: requests[1] })));
		expect(requests).toHaveLength(2);
	});
});
