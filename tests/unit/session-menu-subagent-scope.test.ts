// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { closeContextMenu, getContextMenu } from "../../web/src/context-menu-state.js";

vi.mock("../../web/src/components/DeviceGroupSection.js", () => ({
	DeviceGroupSection: () => createElement("div", { className: "lp-section dg-side-section" }),
}));

let root: Root | null = null;

function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

const dismissEntry = { id: "host:conv-dismiss-subagents", source: "host", label: "关闭已结束的子代理" } as const;
// 只有 dismiss 条目时，一旦它被隐藏菜单就整个不开（contextMenuItems 为空），补一个常驻条目才能观察隐藏结果。
const copyPathEntry = { id: "host:conv-copy-path", source: "host", label: "复制会话文件路径" } as const;

function mount(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(LeftPanel as any, {
					active: true,
					sessionFile: null,
					conversations: [],
					elsewhere: [],
					sessions: [],
					projects: [{ path: "/test", lastUsed: Date.now() }],
					activeConversationId: "",
					panelSend: () => true,
					uiContextSession: [copyPathEntry, dismissEntry],
					...overrides,
				}),
			),
		);
	});
	return container;
}

/** 项目行也是 .lp-row，按行文本定位具体会话行。 */
function findRow(container: HTMLElement, text: string): HTMLElement {
	const row = [...container.querySelectorAll<HTMLElement>(".lp-row[data-session-key]")].find((el) =>
		(el.textContent ?? "").includes(text),
	);
	if (!row) throw new Error(`row not found: ${text}`);
	return row;
}

function rightClick(el: Element) {
	act(() => {
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
	});
}

const finishedForeignSubagent = {
	id: "other-task-1",
	title: "# 任务",
	cwd: "/other-project",
	messageCount: 3,
	isStreaming: false,
	isSubagent: true,
};

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	closeContextMenu();
	document.body.innerHTML = "";
	resetAppGlobals();
	vi.unstubAllGlobals();
});

describe("会话右键：子代理清理只对运行中的对话开放", () => {
	it("历史行不出现「关闭已结束的子代理」，别人的子代理不会被算到这条会话头上", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const container = mount({
			sessions: [{ path: "/test/s1.jsonl", name: "wb破解", firstMessage: "hi", modified: Date.now(), messageCount: 5 }],
			conversations: [finishedForeignSubagent],
		});
		const row = findRow(container, "wb破解");
		rightClick(row);
		const menu = getContextMenu();
		expect(menu?.target).toMatchObject({ kind: "history" });
		const dismiss = menu?.entries.find((entry) => entry.label.includes("关闭"));
		expect(dismiss?.hidden).toBe(true);
	});

	it("运行中的对话仍然按自己的子代理计数并显示含嵌套文案", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const container = mount({
			conversations: [
				{ id: "parent-1", title: "父会话", cwd: "/test", messageCount: 2, isStreaming: false, isSubagent: false },
				{ ...finishedForeignSubagent, id: "child-1", title: "# 任务", cwd: "/test", parentId: "parent-1" },
			],
			activeConversationId: "parent-1",
		});
		rightClick(findRow(container, "父会话"));
		const menu = getContextMenu();
		expect(menu?.target).toMatchObject({ kind: "running", id: "parent-1" });
		expect(menu?.entries.map((entry) => entry.label).join("|")).toContain("含嵌套");
	});
});
