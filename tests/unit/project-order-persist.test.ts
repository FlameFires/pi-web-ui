import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { ClientStateStore, normalizePathKey } from "../../server/client-state.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

const dirs: string[] = [];

function store(): ClientStateStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-project-order-"));
	dirs.push(dir);
	return new ClientStateStore(join(dir, "client-state.json"));
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const applyProjectOrder = protoMethod(ClientSession.prototype, "applyProjectOrder") as unknown as (
	this: unknown,
	list: { path: string; lastUsed: number }[],
) => { path: string; lastUsed: number }[];

describe("手动排位存全局设置（跨窗口 / 跨 origin 一致）", () => {
	it("写进去是归一化路径，读回来保持顺序", () => {
		const s = store();
		s.setProjectOrder(["E:\\work\\b", "E:\\work\\a"]);
		expect(s.getProjectOrder()).toEqual([normalizePathKey("E:\\work\\b"), normalizePathKey("E:\\work\\a")]);
	});

	it("重复项和空值被去掉，顺序按第一次出现", () => {
		const s = store();
		s.setProjectOrder(["E:\\work\\a", "E:\\work\\a", "", "E:\\WORK\\A\\", "E:\\work\\b"]);
		expect(s.getProjectOrder()).toEqual([normalizePathKey("E:\\work\\a"), normalizePathKey("E:\\work\\b")]);
	});

	it("空数组视为清空排位", () => {
		const s = store();
		s.setProjectOrder(["E:\\work\\a"]);
		s.setProjectOrder([]);
		expect(s.getProjectOrder()).toEqual([]);
	});

	it("没有排位时原样返回（自动模式靠 lastUsed，服务端不插手顺序）", () => {
		const ordered = applyProjectOrder.call({}, [
			{ path: "E:\\work\\c", lastUsed: 900 },
			{ path: "E:\\work\\a", lastUsed: 100 },
		]);
		expect(ordered.map((p) => p.path)).toEqual(["E:\\work\\c", "E:\\work\\a"]);
	});

	it("有排位时：排位内的靠前，排位外的按 lastUsed 降序", () => {
		const stateStore = {
			getProjectOrder: () => [normalizePathKey("E:\\work\\b"), normalizePathKey("E:\\work\\a")],
		};
		const ordered = applyProjectOrder.call({ stateStore }, [
			{ path: "E:\\work\\z", lastUsed: 1000 },
			{ path: "E:\\work\\a", lastUsed: 100 },
			{ path: "E:\\work\\b", lastUsed: 500 },
			{ path: "E:\\work\\y", lastUsed: 2000 },
		]);
		expect(ordered.map((p) => p.path)).toEqual(["E:\\work\\b", "E:\\work\\a", "E:\\work\\y", "E:\\work\\z"]);
	});

	it("reorderProjects 写排位并立即重推 projects", async () => {
		const setProjectOrder = vi.fn();
		const pushProjects = vi.fn(async () => {});
		const cs = fakeClientSession({
			cwd: "E:\\work\\a",
			stateStore: { getProjectOrder: () => [], setProjectOrder },
			pushProjects,
		});

		await (
			ClientSession.prototype as unknown as { reorderProjects: (p: string[]) => Promise<void> }
		).reorderProjects.call(cs, ["E:\\work\\b", "E:\\work\\a"]);

		expect(setProjectOrder).toHaveBeenCalledWith(["E:\\work\\b", "E:\\work\\a"]);
		expect(pushProjects).toHaveBeenCalledTimes(1);
	});
});

describe("广播接线（防回归）", () => {
	// 曾经漏过：引擎门面（index.ts 的 EngineService 对象字面量）没转接 pushProjectsToAll，
	// `daemon?.pushProjectsToAll?.()` 的可选链静默跳过，只有拖动方自己重排，另一窗口要刷新才同步。
	it("index.ts 的引擎门面真的把 pushProjectsToAll 转给 AgentService", () => {
		const src = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
		expect(src).toContain("pushProjectsToAll?(): Promise<void>;");
		const start = src.indexOf("async pushProjectsToAll()");
		expect(start).toBeGreaterThan(-1);
		const block = src.slice(start, start + 400);
		expect(block).toContain("engine.pushProjectsToAll");
		expect(block).toContain("AgentService");
	});

	it("dispatch 的 reorder_projects 会广播给所有客户端", () => {
		const src = readFileSync(new URL("../../server/dispatch-domain-handlers.ts", import.meta.url), "utf8");
		const start = src.indexOf('case "reorder_projects":');
		expect(start).toBeGreaterThan(-1);
		const block = src.slice(start, src.indexOf("return true;", start));
		expect(block).toContain("cs.reorderProjects");
		expect(block).toContain("pushProjectsToAll");
	});
});
