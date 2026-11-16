// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { readExpandedPaths, writeExpandedPaths } from "../../web/src/session-files-expanded";

const scope = "/sessions/one.jsonl\0/repo";

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	window.localStorage.clear();
});

it("round-trips expanded paths per scope", () => {
	expect(readExpandedPaths(scope)).toEqual([]);
	writeExpandedPaths(scope, ["docs/a.md", "docs/b.md"]);
	expect(readExpandedPaths(scope)).toEqual(["docs/a.md", "docs/b.md"]);
	expect(readExpandedPaths("/sessions/two.jsonl\0/repo")).toEqual([]);
});

it("clears the entry when the last path collapses", () => {
	writeExpandedPaths(scope, ["docs/a.md"]);
	writeExpandedPaths(scope, []);
	expect(readExpandedPaths(scope)).toEqual([]);
	expect(window.localStorage.length).toBe(0);
});

it("ignores blank scopes, blank paths and corrupted values", () => {
	writeExpandedPaths("", ["docs/a.md"]);
	expect(window.localStorage.length).toBe(0);
	writeExpandedPaths(scope, ["", "docs/a.md"]);
	expect(readExpandedPaths(scope)).toEqual(["docs/a.md"]);
	window.localStorage.setItem("pi-web-ui:session-files-expanded:" + scope, "{not json");
	expect(readExpandedPaths(scope)).toEqual([]);
	window.localStorage.setItem("pi-web-ui:session-files-expanded:" + scope, JSON.stringify({ path: "docs/a.md" }));
	expect(readExpandedPaths(scope)).toEqual([]);
});

it("caps remembered paths so storage cannot grow without bound", () => {
	writeExpandedPaths(
		scope,
		Array.from({ length: 240 }, (_, index) => `docs/${index}.md`),
	);
	const remembered = readExpandedPaths(scope);
	expect(remembered).toHaveLength(200);
	expect(remembered[0]).toBe("docs/40.md");
	expect(remembered[199]).toBe("docs/239.md");
});
