import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClientSession } from "../helpers/fake-session";
import { SessionFileLedger } from "../../server/session-file-ledger";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "file-ledger-runtime-"));
	dirs.push(dir);
	const identity = { conversationId: "original", sessionFile: join(dir, "session.jsonl"), cwd: dir };
	await writeFile(identity.sessionFile, "");
	const conv = { id: identity.conversationId, cwd: dir, session: { sessionFile: identity.sessionFile } };
	const settings = { sessionChangedFilesEnabled: true };
	const events: any[] = [];
	const client = fakeClientSession({
		cwd: dir,
		convs: new Map([[conv.id, conv]]),
		activeId: conv.id,
		stateStore: { dataDir: dir },
		settingsSvc: { current: settings },
		emit: (event: any) => events.push(event),
		emitNotice: () => {},
	}) as any;
	return { dir, identity, conv, settings, client, events, ledger: new SessionFileLedger(dir, identity) };
}
describe("session-file-ledger runtime", () => {
	it("captures actual write/edit evidence and keeps original ownership across awaits", async () => {
		const { client, dir, conv, ledger, events, identity } = await fixture();
		const tool = client.withFileLedger(
			{
				name: "write",
				execute: async (_id: string, args: any) => {
					client.activeId = "other";
					await writeFile(join(dir, args.path), args.content);
					return { content: [{ type: "text", text: "written" }] };
				},
			},
			conv.id,
			dir,
		);
		await tool.execute("create", { path: "file.txt", content: "created\n" });
		const edit = client.withFileLedger(
			{
				name: "edit",
				execute: async () => {
					await writeFile(join(dir, "file.txt"), "updated\n");
					return { content: [{ type: "text", text: "edited" }] };
				},
			},
			conv.id,
			dir,
		);
		await edit.execute("edit", { path: "file.txt", edits: [{ oldText: "created", newText: "updated" }] });
		const detail = await ledger.page("q", "file.txt");
		expect(detail.operations).toHaveLength(2);
		expect(detail.cumulative).toMatchObject({ status: "exact", patch: expect.stringContaining("+updated") });
		expect(events.every((event) => event.conversationId === identity.conversationId)).toBe(true);
		await client.sessionFileLedger({ type: "session_file_ledger", ...identity, reqId: "request" });
		expect(events.some((event) => event.type === "session_file_ledger_page" && event.reqId === "request")).toBe(true);
		await Promise.all([...client.fileLedgerBackfills.values()]);
	});
	it("skips failed/noop tools and disabled recording while retaining tool behavior", async () => {
		const { client, dir, conv, ledger, settings } = await fixture();
		await writeFile(join(dir, "file.txt"), "same");
		const noop = client.withFileLedger(
			{ name: "write", execute: async () => ({ content: [{ type: "text", text: "done" }] }) },
			conv.id,
			dir,
		);
		await noop.execute("noop", { path: "file.txt", content: "same" });
		const failure = client.withFileLedger(
			{
				name: "edit",
				execute: async () => {
					throw new Error("failed");
				},
			},
			conv.id,
			dir,
		);
		await expect(failure.execute("failure", { path: "file.txt" })).rejects.toThrow("failed");
		settings.sessionChangedFilesEnabled = false;
		const disabled = client.withFileLedger(
			{
				name: "write",
				execute: async () => {
					await writeFile(join(dir, "file.txt"), "changed");
					return { content: [] };
				},
			},
			conv.id,
			dir,
		);
		await disabled.execute("disabled", { path: "file.txt" });
		expect((await ledger.page("q")).files).toEqual([]);
	});
});
