import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
	vi.resetModules();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "main-recovery-"));
	dirs.push(dir);
	return dir;
}
describe("main session restart recovery", () => {
	it("retains two interrupted main sessions in their original projects across restart", async () => {
		const dir = await directory();
		const before = await import("../../server/main-session-recovery.js");
		const first = { sessionFile: join(dir, "self.jsonl"), cwd: join(dir, "self"), title: "Self" };
		const second = { sessionFile: join(dir, "client.jsonl"), cwd: join(dir, "client"), title: "Client" };
		await Promise.all([before.markMainRun(dir, first), before.markMainRun(dir, second)]);
		expect(await before.interruptedMainRun(dir, first.sessionFile)).toBeUndefined();
		vi.resetModules();
		const after = await import("../../server/main-session-recovery.js");
		expect(await after.interruptedMainRun(dir, first.sessionFile)).toMatchObject(first);
		expect(await after.interruptedMainRun(dir, second.sessionFile)).toMatchObject(second);
		expect(await after.interruptedMainRun(dir, join(dir, "repo.jsonl"))).toBeUndefined();
	});
	it("does not recover completed runs and serializes start and finish writes", async () => {
		const dir = await directory();
		const before = await import("../../server/main-session-recovery.js");
		const marker = { sessionFile: join(dir, "self.jsonl"), cwd: dir, title: "Done" };
		await Promise.all([before.markMainRun(dir, marker), before.settleMainRun(dir, marker.sessionFile)]);
		vi.resetModules();
		const after = await import("../../server/main-session-recovery.js");
		expect(await after.interruptedMainRun(dir, marker.sessionFile)).toBeUndefined();
	});
});
