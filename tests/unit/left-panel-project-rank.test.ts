// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";

const MANUAL_KEY = "pi-web-ui:project-order-manual";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function stubStorage(seed: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(seed));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
	return store;
}

type Project = { path: string; lastUsed: number };

function mount(projects: Project[], seed: Record<string, string> = {}) {
	const store = stubStorage(seed);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	setAppGlobals({ cwd: projects[0]?.path ?? "/w", ready: true, status: "open" });
	const render = (next: Project[]) => {
		const props = {
			active: true,
			sessionFile: null,
			conversations: [],
			elsewhere: [],
			sessions: [],
			projects: next,
			activeConversationId: "",
			panelSend: () => true,
		};
		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});
	};
	render(projects);
	return { store, render };
}

function projectTitles(): string[] {
	return [...container!.querySelectorAll(".projects-scroll .project-item .lp-project-name")].map((el) =>
		(el.textContent ?? "").trim(),
	);
}

afterEach(() => {
	if (root && container) {
		act(() => root!.unmount());
		container.remove();
	}
	root = null;
	container = null;
	vi.restoreAllMocks();
	try {
		resetAppGlobals();
	} catch {}
});

describe("手动模式：项目顺序以服务端下发为准", () => {
	// 手动排位存在服务端全局设置里（`__settings__.projectOrder`）：一个窗口用 localhost、
	// 另一个用 127.0.0.1 时 localStorage 不共享，只有服务端顺序靠得住。
	it("按 projects 下发的顺序渲染，不看 lastUsed", () => {
		mount(
			[
				{ path: "/w/old", lastUsed: 1 },
				{ path: "/w/new", lastUsed: 999 },
			],
			{ [MANUAL_KEY]: "1" },
		);
		expect(projectTitles().map((t) => t.split("\n")[0])).toEqual(["old", "new"]);
	});

	it("服务端广播了新顺序后立即跟随", () => {
		const { render } = mount(
			[
				{ path: "/w/old", lastUsed: 1 },
				{ path: "/w/new", lastUsed: 2 },
			],
			{ [MANUAL_KEY]: "1" },
		);
		expect(projectTitles().map((t) => t.split("\n")[0])).toEqual(["old", "new"]);

		render([
			{ path: "/w/new", lastUsed: 2 },
			{ path: "/w/old", lastUsed: 1 },
		]);
		expect(projectTitles().map((t) => t.split("\n")[0])).toEqual(["new", "old"]);
	});

	it("自动模式仍按 lastUsed 排，忽略下发顺序", () => {
		mount(
			[
				{ path: "/w/old", lastUsed: 1 },
				{ path: "/w/new", lastUsed: 999 },
			],
			{ [MANUAL_KEY]: "0" },
		);
		expect(projectTitles().map((t) => t.split("\n")[0])).toEqual(["new", "old"]);
	});
});
