import { describe, expect, it, vi } from "vitest";
import { fakeClientSession } from "../helpers/fake-session.js";
import { handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import { enqueueNotice, type NoticeLike } from "../../web/src/notice-policy.js";

function client() {
	const records = [{ runId: "old-run", title: "Interrupted task", type: "implement", state: "interrupted" }];
	const resume = vi.fn().mockResolvedValue({ ok: true, runId: "old-run", convId: "new-run" });
	const session: any = fakeClientSession({
		activeId: "parent",
		convs: new Map([["parent", { id: "parent", session: { sessionFile: "/projects/self/session.jsonl" } }]]),
		interruptedSubagentOffers: new Map(),
		resumingInterruptedSubagents: new Set(),
		subagentLedgerStore: {
			enabled: true,
			recover: vi.fn().mockResolvedValue(records),
			list: vi.fn(() => records),
			read: vi.fn(() => records[0]),
		},
		resumeSubagentRun: resume,
		sinks: new Set([{}]),
		emit: vi.fn(),
	});
	return { session, resume, records };
}

describe("interrupted subagent recovery actions", () => {
	it("resumes a main session in its original conversation after the active view changes", async () => {
		const { session, resume } = client();
		const original = session.convs.get("parent");
		session.interruptedMainOffers.set("main:original", original);
		session.activeId = "repo";
		session.getLang = () => "en";
		session.prompt = vi.fn().mockResolvedValue(undefined);
		expect(await session.resumeInterruptedSubagent("main:original")).toEqual({ ok: true });
		expect(session.prompt).toHaveBeenCalledWith(expect.any(String), undefined, false, original);
		expect(resume).not.toHaveBeenCalled();
		expect(await session.resumeInterruptedSubagent("main:original")).toEqual({ ok: false, error: "not_available" });
	});
	it("offers both tasks from the original parent and excludes another project", async () => {
		const { session } = client();
		const records = [
			{ runId: "one", title: "One", parentSessionFile: "/projects/self/session.jsonl" },
			{ runId: "two", title: "Two", parentSessionFile: "/projects/self/session.jsonl" },
			{ runId: "repo", title: "Other project", parentSessionFile: "/projects/repo/session.jsonl" },
		];
		session.subagentLedgerStore.recover.mockImplementation(async (matches: (record: any) => boolean) =>
			records.filter(matches),
		);
		await session.recoverSubagentRuns();
		expect(session.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				interruptedRuns: [
					{ runId: "one", title: "One" },
					{ runId: "two", title: "Two" },
				],
			}),
		);
		expect([...session.interruptedSubagentOffers.entries()]).toEqual([
			["one", "parent"],
			["two", "parent"],
		]);
	});
	it("keeps an actionable recovery notice when ordinary notifications arrive", () => {
		const recovery = { id: 1, level: "warning" as const, text: "Recovery", interruptedRuns: [{ runId: "old-run" }] };
		const error = { id: 2, level: "error" as const, text: "Error" };
		const info = { id: 3, level: "info" as const, text: "Connected" };
		expect(enqueueNotice<NoticeLike>([recovery, error], info)).toEqual([recovery, error]);
	});
	it("offers recovery without starting a task and retains the parent across view switches", async () => {
		const { session, resume } = client();
		await session.recoverSubagentRuns();
		expect(resume).not.toHaveBeenCalled();
		expect(session.emit).toHaveBeenCalledWith(
			expect.objectContaining({ interruptedRuns: [{ runId: "old-run", title: "Interrupted task" }] }),
		);
		session.activeId = "other";
		expect(await session.resumeInterruptedSubagent("old-run")).toEqual({ ok: true, error: undefined });
		expect(resume).toHaveBeenCalledWith("parent", "old-run");
		expect((await session.resumeInterruptedSubagent("old-run")).ok).toBe(false);
		expect(resume).toHaveBeenCalledTimes(1);
	});
	it("rejects unknown tasks and concurrent duplicates, then permits retry after failure", async () => {
		const { session, resume } = client();
		expect((await session.resumeInterruptedSubagent("unknown")).ok).toBe(false);
		await session.recoverSubagentRuns();
		let finish!: (result: any) => void;
		resume.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const first = session.resumeInterruptedSubagent("old-run");
		expect(await session.resumeInterruptedSubagent("old-run")).toEqual({ ok: false, error: "running" });
		finish({ ok: false, error: "parent_missing" });
		expect((await first).ok).toBe(false);
		expect((await session.resumeInterruptedSubagent("old-run")).ok).toBe(true);
	});
	it("does not restart a task that was already resumed elsewhere", async () => {
		const { session, resume, records } = client();
		await session.recoverSubagentRuns();
		Object.assign(records[0], { resumedBy: "replacement" });
		expect((await session.resumeInterruptedSubagent("old-run")).ok).toBe(false);
		expect(resume).not.toHaveBeenCalled();
	});
	it("returns a result to the requesting client", async () => {
		const send = vi.fn();
		const session: any = { resumeInterruptedSubagent: vi.fn().mockResolvedValue({ ok: true }) };
		expect(
			handleSessionLifecycleMessage({ type: "resume_interrupted_subagent", runId: "old-run" }, session, send),
		).toBe(true);
		await Promise.resolve();
		expect(send).toHaveBeenCalledWith({ type: "subagent_resume_result", runId: "old-run", ok: true });
	});
});
