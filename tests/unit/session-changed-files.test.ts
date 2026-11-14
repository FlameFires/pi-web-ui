import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../web/src/types";
import { collectSessionChangedFiles } from "../../web/src/session-changed-files";

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
		expect(files.map((f) => [f.path, f.deleted])).toEqual([
			["a", false],
			["gone", true],
			["new", false],
			["old", true],
		]);
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
