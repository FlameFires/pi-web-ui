import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../web/src/types";
import { collectSessionChangedFiles } from "../../web/src/session-changed-files";
import { samePreviewPath } from "../../web/src/file-preview-path";

function mutation(id: string, name: string, args: unknown, details?: unknown, isError = false): UiMessage[] {
	return [
		{
			id: `a-${id}`,
			role: "assistant",
			content: [{ type: "toolCall", id, name, argumentsText: JSON.stringify(args) }],
		},
		{
			id: `r-${id}`,
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			isError,
			details,
			content: [{ type: "text", text: "done" }],
		},
	];
}

describe("session changed files", () => {
	it("groups repeated successful operations by path and preserves their records", () => {
		const messages = [
			...mutation("1", "write", { path: "./src/a.ts", content: "one" }),
			...mutation("2", "edit", { path: "/repo/src/a.ts", edits: [{ oldText: "one", newText: "two" }] }),
			...mutation("3", "write", { path: "b.md" }),
		];
		const files = collectSessionChangedFiles(messages, "/repo");
		expect(files.map((f) => f.path)).toEqual(["b.md", "src/a.ts"]);
		expect(files[1].operations.map((op) => op.id)).toEqual(["1", "2"]);
		expect(files[1].operations[0].argumentsText).toContain("one");
	});
	it("excludes reads, failed edits, no-op results and unfinished calls", () => {
		const messages = [
			...mutation("read", "read", { path: "a" }),
			...mutation("fail", "edit", { path: "b" }, undefined, true),
			...mutation("noop", "replace", { path: "c" }, { classification: "noop" }),
			...mutation("bad", "patch", {}, { ok: false, results: [{ filePath: "d", op: "updated" }] }),
			mutation("running", "write", { path: "e" })[0],
		];
		expect(collectSessionChangedFiles(messages, "/repo")).toEqual([]);
	});
	it("uses returned paths for anchor edits and ignores duplicate tool results", () => {
		const messages = mutation("1", "functions.replace", { remove_from: "abcde" }, { ok: true, path: "docs/a.md" });
		messages.push(messages[1]);
		const files = collectSessionChangedFiles(messages, "/repo");
		expect(files[0].path).toBe("docs/a.md");
		expect(files[0].operations).toHaveLength(1);
	});
	it("derives the path from the unified patch header when anchor edits omit path", () => {
		const patch = "--- a/docs/b.md\n+++ b/docs/b.md\n@@ -1 +1 @@\n-old\n+new\n";
		const messages = mutation("1", "replace_match", { match: "old", replacement: "new" }, { patch });
		const files = collectSessionChangedFiles(messages, "/repo");
		expect(files.map((f) => f.path)).toEqual(["docs/b.md"]);
		expect(files[0].operations).toHaveLength(1);
		expect(files[0].operations[0].label).toBe("edited");
	});
	it("tracks all patch results including deleted and moved paths", () => {
		const files = collectSessionChangedFiles(
			mutation(
				"1",
				"patch",
				{},
				{
					ok: true,
					results: [
						{ filePath: "a", op: "updated" },
						{ filePath: "gone", op: "deleted" },
						{ filePath: "old", op: "moved", newPath: "new" },
					],
				},
			),
			"/repo",
		);
		expect(files.map((f) => [f.path, f.status])).toEqual([
			["a", "present"],
			["gone", "deleted"],
			["new", "present"],
			["old", "moved"],
		]);
	});
	it("marks a file created and later removed by successful rm as deleted, preserving ordered operations", () => {
		const messages = [
			...mutation("create", "write", { path: "delta.txt", content: "x" }),
			...mutation("remove", "bash", { command: 'cd "C:/Users/vi/Desktop/tst" && rm -f delta.txt' }, { exitCode: 0 }),
		];
		const [file] = collectSessionChangedFiles(messages, "C:/Users/vi/Desktop/tst");
		expect(file.path).toBe("delta.txt");
		expect(file.status).toBe("deleted");
		expect(file.operations.map((op) => op.label)).toEqual(["created", "deleted"]);
	});
	it("tracks cd-relative moves and deletes in history order", () => {
		const messages = [
			...mutation("create", "write", { path: "tmp_delete_me.txt", content: "x" }),
			...mutation(
				"move",
				"bash",
				{ command: 'cd "C:/Users/vi/Desktop/tst" && mkdir -p sub && mv tmp_delete_me.txt sub/moved.txt' },
				{ exitCode: 0 },
			),
			...mutation(
				"remove",
				"bash",
				{ command: 'cd "C:/Users/vi/Desktop/tst" && rm -f sub/moved.txt && rmdir sub' },
				{ exitCode: 0 },
			),
		];
		const files = collectSessionChangedFiles(messages, "C:/Users/vi/Desktop/tst");
		expect(files.map((file) => [file.path, file.status])).toEqual([
			["sub", "deleted"],
			["sub/moved.txt", "deleted"],
			["tmp_delete_me.txt", "moved"],
		]);
		expect(files.find((file) => file.path === "tmp_delete_me.txt")?.operations.map((op) => op.label)).toEqual([
			"created",
			"moved",
		]);
		expect(files.find((file) => file.path === "sub")?.kind).toBe("dir");
		expect(files.find((file) => file.path === "sub/moved.txt")?.operations.map((op) => op.label)).toEqual([
			"moved",
			"deleted",
		]);
	});
	it("does not count failed shell deletes", () => {
		expect(
			collectSessionChangedFiles(
				mutation("remove", "bash", { command: "rm -f missing.txt" }, { exitCode: 1, stderr: "failure" }),
				"/repo",
			),
		).toEqual([]);
	});
	it("merges Windows absolute, relative, separator and case variants", () => {
		const messages = [
			...mutation("1", "write", { path: "C:\\Repo\\src\\A.ts" }),
			...mutation("2", "edit", { file_path: "src/a.ts" }),
			...mutation("3", "edit", { path: "src/sub/../a.ts" }),
		];
		const files = collectSessionChangedFiles(messages, "c:/repo");
		expect(files).toHaveLength(1);
		expect(files[0].operations).toHaveLength(3);
	});
	it("matches absolute Windows preview receipt paths regardless of slash and drive casing", () => {
		expect(samePreviewPath("C:\\Repo\\src\\a.ts", "c:/repo/src/a.ts")).toBe(true);
		expect(samePreviewPath("/repo/src/a.ts", "/repo/src/b.ts")).toBe(false);
	});
	it("does not merge case-sensitive POSIX files or paths outside the workspace", () => {
		const files = collectSessionChangedFiles(
			[
				...mutation("1", "write", { path: "A" }),
				...mutation("2", "write", { path: "a" }),
				...mutation("3", "write", { path: "/repo-other/a" }),
			],
			"/repo",
		);
		expect(files).toHaveLength(3);
		expect(files.some((file) => file.path === "/repo-other/a")).toBe(true);
	});
	it("handles paginated results with retained path metadata and no tool-call args", () => {
		const result = mutation("1", "edit", {}, { path: "a" })[1];
		expect(collectSessionChangedFiles([result], "/repo")[0].path).toBe("a");
		expect(collectSessionChangedFiles([{ ...result, details: undefined }], "/repo")).toEqual([]);
	});
	it("has no retained state between conversations and reflects rollback", () => {
		const messages = mutation("1", "write", { path: "a" });
		expect(collectSessionChangedFiles(messages, "/repo")).toHaveLength(1);
		expect(collectSessionChangedFiles([], "/repo")).toEqual([]);
		expect(collectSessionChangedFiles(messages.slice(0, 1), "/repo")).toEqual([]);
	});
});
