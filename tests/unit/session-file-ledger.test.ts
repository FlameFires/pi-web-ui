import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SessionFileLedger } from "../../server/session-file-ledger";
import { captureFileEvidence } from "../../server/session-file-evidence";
import type { UiMessage } from "../../server/protocol";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "session-file-ledger-"));
	directories.push(dir);
	const identity = { conversationId: "c1", sessionFile: join(dir, "session.jsonl"), cwd: dir };
	await writeFile(identity.sessionFile, "");
	return { dir, identity, ledger: new SessionFileLedger(dir, identity) };
}
function mutation(
	id: string,
	name = "write",
	args: unknown = { path: "a.txt", content: "one" },
	details?: unknown,
	isError = false,
	timestamp = 1,
): UiMessage[] {
	return [
		{
			id: `call-${id}`,
			role: "assistant",
			content: [{ type: "toolCall", id, name, argumentsText: JSON.stringify(args) }],
		},
		{
			id: `result-${id}`,
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "done" }],
			details,
			isError,
			timestamp,
		},
	];
}
const evidence = (before: string, after: string, exists = true) => ({
	before: { available: true as const, exists, text: before },
	after: { available: true as const, exists: true, text: after },
});

describe("session-file-ledger", () => {
	it("merges Windows case variants across separate events and rejects a discontinuous cumulative chain", async () => {
		const { dir, identity } = await fixture();
		const ledger = new SessionFileLedger(dir, { ...identity, cwd: "C:/repo" });
		await ledger.append(mutation("1", "write", { path: "C:/repo/File.txt" }), evidence("before", "middle"));
		await ledger.append(mutation("2", "edit", { path: "file.TXT" }), evidence("external change", "after"));
		expect((await ledger.page("q")).files).toHaveLength(1);
		expect((await ledger.page("q", "File.txt")).operations).toHaveLength(2);
		expect((await ledger.page("q", "File.txt")).cumulative.status).toBe("unavailable");
	});
	it("persists, isolates session/cwd, and deduplicates concurrent repeated events across restart", async () => {
		const { dir, identity, ledger } = await fixture();
		await Promise.all([ledger.append(mutation("1")), ledger.append(mutation("1"))]);
		const restarted = new SessionFileLedger(dir, { ...identity, conversationId: "reopened" });
		expect((await restarted.page("q")).files).toEqual([
			{ path: "a.txt", kind: "file", status: "present", operationCount: 1 },
		]);
		expect(await restarted.append(mutation("1"))).toBe(false);
		expect(
			(await new SessionFileLedger(dir, { ...identity, sessionFile: identity.sessionFile + "other" }).page("q")).files,
		).toEqual([]);
		expect((await new SessionFileLedger(dir, { ...identity, cwd: dir + "other" }).page("q")).files).toEqual([]);
	});
	it("excludes failed, unfinished, explicit noop and unchanged evidence", async () => {
		const { ledger } = await fixture();
		expect(await ledger.append(mutation("failure", "write", { path: "bad" }, undefined, true))).toBe(false);
		expect(await ledger.append(mutation("noop", "edit", { path: "bad" }, { classification: "noop" }))).toBe(false);
		expect(await ledger.append(mutation("unchanged"), evidence("one", "one"))).toBe(false);
		expect(await ledger.append([mutation("pending")[0]])).toBe(false);
		expect((await ledger.page("q")).files).toEqual([]);
	});
	it("retains creation/deletion/move operation trails and final state", async () => {
		const { ledger } = await fixture();
		await ledger.append(mutation("create"), evidence("", "one", false));
		await ledger.append(mutation("move", "bash", { command: "mv a.txt b.txt" }, { exitCode: 0 }, false, 2));
		await ledger.append(mutation("delete", "bash", { command: "rm b.txt" }, { exitCode: 0 }, false, 3));
		const page = await ledger.page("q");
		expect(page.files.map((file) => [file.path, file.status, file.operationCount])).toEqual([
			["a.txt", "moved", 2],
			["b.txt", "deleted", 2],
		]);
		expect((await ledger.page("detail", "a.txt")).operations.map((op) => op.id)).toEqual(["create", "move"]);
		expect((await ledger.page("detail", "a.txt")).cumulative.status).toBe("unavailable");
	});
	it("keeps exact first-before/latest-after including reverted net changes without inventing old baselines", async () => {
		const { ledger } = await fixture();
		await ledger.append(mutation("1"), evidence("original\n", "middle\n"));
		await ledger.append(mutation("2", "edit", { path: "a.txt" }, undefined, false, 2), evidence("middle\n", "final\n"));
		const page = await ledger.page("q", "a.txt");
		expect(page.cumulative).toMatchObject({ status: "exact", patch: expect.stringContaining("-original\n+final") });
		await ledger.append(
			mutation("3", "edit", { path: "a.txt" }, undefined, false, 3),
			evidence("final\n", "original\n"),
		);
		expect((await ledger.page("q", "a.txt")).cumulative).toEqual({ status: "exact", patch: "" });
		await ledger.append(mutation("historical", "edit", { path: "old.txt" }));
		await ledger.append(mutation("new", "edit", { path: "old.txt" }), evidence("current", "changed"));
		expect((await ledger.page("q", "old.txt")).cumulative.status).toBe("unavailable");
	});
	it("paginates files and operation histories with scoped stable cursors and byte budgets", async () => {
		const { ledger, dir, identity } = await fixture();
		for (let i = 0; i < 34; i++) await ledger.append(mutation(String(i), "write", { path: `file-${i}.txt` }));
		const first = await ledger.page("q");
		expect(first.files).toHaveLength(30);
		await ledger.append(mutation("late", "write", { path: "late.txt" }));
		const next = await ledger.page("q", undefined, first.nextCursor);
		expect(next.files).toHaveLength(5);
		expect(new Set([...first.files, ...next.files].map((file) => file.path)).size).toBe(35);
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(48 * 1024);
		await expect(ledger.page("q", "file-0.txt", first.nextCursor)).rejects.toThrow("Invalid ledger cursor");
		await expect(
			new SessionFileLedger(dir, { ...identity, cwd: "different" }).page("q", undefined, first.nextCursor),
		).rejects.toThrow();
		for (let i = 0; i < 32; i++) await ledger.append(mutation(`op-${i}`, "edit", { path: "history.txt" }));
		const operations = await ledger.page("q", "history.txt");
		expect(operations.operations).toHaveLength(30);
		expect((await ledger.page("q", "history.txt", operations.nextCursor)).operations).toHaveLength(2);
	});
	it("pages large raw operation payloads and exact cumulative content instead of inflating messages", async () => {
		const { ledger } = await fixture();
		const text = "中文\n".repeat(6000);
		await ledger.append(mutation("large", "write", { path: "a.txt", content: text }), evidence("", text, false));
		const page = await ledger.page("q", "a.txt");
		expect(page.operations[0].truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(48 * 1024);
		let raw = "",
			offset: number | undefined = 0;
		do {
			const chunk = await ledger.page("q", "a.txt", undefined, { operationId: "large", offset });
			raw += chunk.rawText;
			offset = chunk.nextOffset;
			expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(48 * 1024);
		} while (offset !== undefined);
		expect(JSON.parse(raw).argumentsText).toContain("中文");
		const cumulative = await ledger.page("q", "a.txt", undefined, { cumulative: true });
		expect(cumulative.cumulative.status).toBe("exact");
		await expect(ledger.page("q", "a.txt", undefined, { offset: -1 })).rejects.toThrow("Invalid content offset");
	});
	it("backfills disk transcript once regardless of front-end history pages and preserves abandoned branches", async () => {
		const { ledger, identity } = await fixture();
		const lines = [
			{
				type: "message",
				id: "a",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "old", name: "write", arguments: { path: "old.txt" } }],
				},
			},
			{
				type: "message",
				parentId: "a",
				message: {
					role: "toolResult",
					toolCallId: "old",
					toolName: "write",
					content: [{ type: "text", text: "done" }],
				},
			},
			{ type: "branch", parentId: "elsewhere" },
		];
		await writeFile(identity.sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
		expect(await ledger.backfill()).toBe(true);
		expect(await ledger.backfill()).toBe(false);
		expect((await ledger.page("q")).files[0].path).toBe("old.txt");
		expect((await ledger.page("q")).coverage).toBe("available-transcript");
		expect((await ledger.page("q", "old.txt")).cumulative.status).toBe("unavailable");
	});
	it("does not backfill while disabled and marks skipped transcript evidence partial", async () => {
		const { ledger, identity } = await fixture();
		await writeFile(identity.sessionFile, "invalid-json\n");
		expect(await ledger.backfill(() => false)).toBe(false);
		expect((await ledger.page("q")).coverage).toBe("recorded-only");
		await ledger.backfill();
		expect((await ledger.page("q")).coverage).toBe("partial-transcript");
	});
	it("replays an interrupted transaction idempotently before serving or deduplicating", async () => {
		const { ledger } = await fixture();
		const operation = { id: "interrupted", toolName: "write", output: "done" };
		const key = "0000000000000001.json";
		await mkdir(ledger.directory, { recursive: true });
		await writeFile(
			join(ledger.directory, "head.json"),
			JSON.stringify({ version: 1, sequence: 1, backfilled: false }),
		);
		await writeFile(
			join(ledger.directory, "pending.json"),
			JSON.stringify({
				path: "a.txt",
				key,
				operation,
				summary: { path: "a.txt", kind: "file", status: "present", operationCount: 1, key, lastTimestamp: 1 },
				evidence: evidence("", "one", false),
			}),
		);
		const fileDir = join(ledger.directory, "files", createHash("sha256").update("a.txt").digest("hex"));
		await mkdir(join(fileDir, "operations"), { recursive: true });
		await writeFile(join(fileDir, "operations", key), JSON.stringify({ operation, raw: key }));
		expect((await ledger.page("q")).files[0].operationCount).toBe(1);
		expect(JSON.parse(await readFile(join(fileDir, key), "utf8")).id).toBe("interrupted");
		expect(await ledger.append(mutation("interrupted"))).toBe(false);
	});
	it("captures bounded UTF-8 evidence, absent files, and rejects binary/oversized content", async () => {
		const { dir } = await fixture();
		expect(await captureFileEvidence(join(dir, "missing"))).toEqual({ available: true, exists: false, text: "" });
		await writeFile(join(dir, "text"), "hello\n");
		expect(await captureFileEvidence(join(dir, "text"))).toEqual({ available: true, exists: true, text: "hello\n" });
		await writeFile(join(dir, "binary"), Buffer.from([0, 1, 2]));
		expect(await captureFileEvidence(join(dir, "binary"))).toEqual({ available: false });
		await writeFile(join(dir, "large"), "x".repeat(256 * 1024 + 1));
		expect(await captureFileEvidence(join(dir, "large"))).toEqual({ available: false });
	});
});
