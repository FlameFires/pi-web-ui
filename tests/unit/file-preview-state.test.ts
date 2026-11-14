// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readPreviewSnapshot, useFilePreviewState } from "../../web/src/use-file-preview-state";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let state: ReturnType<typeof useFilePreviewState>;
const container = document.createElement("div");
const files = [
	{ path: "docs/a.md", name: "a.md" },
	{ path: "docs/b.md", name: "b.md" },
];
function Harness({ scope }: { scope: string }) {
	state = useFilePreviewState(scope);
	return null;
}
function render(scope = "/project-a") {
	act(() => root.render(createElement(Harness, { scope })));
}
beforeEach(() => {
	sessionStorage.clear();
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	vi.restoreAllMocks();
});
it("retains the complete file group and selected tab after closing and reopening", () => {
	render();
	act(() => {
		state.setPreviewFiles(files);
		state.setPreviewIndex(1);
	});
	act(() => state.setPreviewFiles(null));
	expect(state.previewFiles).toBeNull();
	expect(state.recentPreview).toEqual({ files, index: 1 });
	act(() => state.reopenPreview());
	expect(state.previewFiles).toEqual(files);
	expect(state.previewIndex).toBe(1);
});
it("restores the entry after a refresh without opening a modal automatically", () => {
	render();
	act(() => {
		state.setPreviewFiles(files);
		state.setPreviewIndex(1);
	});
	act(() => root.unmount());
	root = createRoot(container);
	render();
	expect(state.previewFiles).toBeNull();
	expect(state.recentPreview).toEqual({ files, index: 1 });
	act(() => state.reopenPreview());
	expect(state.previewIndex).toBe(1);
	expect(state.previewFiles).toEqual(files);
});
it("isolates relative paths by project and closes previews when switching projects", () => {
	render();
	act(() => {
		state.setPreviewFiles(files);
		state.setPreviewIndex(1);
	});
	render("/project-b");
	expect(state.previewFiles).toBeNull();
	expect(state.recentPreview).toBeNull();
	act(() => state.setPreviewFiles([{ path: "b.txt", name: "b.txt" }]));
	render();
	expect(state.previewFiles).toBeNull();
	expect(state.recentPreview).toEqual({ files, index: 1 });
});
it("replaces the last group when opening another group", () => {
	render();
	act(() => {
		state.setPreviewFiles(files);
		state.setPreviewIndex(1);
	});
	act(() => state.setPreviewFiles([files[0]]));
	expect(state.recentPreview).toEqual({ files: [files[0]], index: 0 });
});
it("keeps working when browser storage is blocked", () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("quota");
	});
	render();
	act(() => state.setPreviewFiles(files));
	act(() => state.setPreviewFiles(null));
	act(() => state.reopenPreview());
	expect(state.previewFiles).toEqual(files);
});
it("ignores malformed storage and clamps an out-of-range selected tab", () => {
	const key = "pi-web-ui:recent-preview:/project-a";
	for (const value of ["{", "null", '{"files":[null]}', '{"files":[]}']) {
		sessionStorage.setItem(key, value);
		expect(readPreviewSnapshot("/project-a")).toBeNull();
	}
	sessionStorage.setItem(key, JSON.stringify({ files, index: 999 }));
	expect(readPreviewSnapshot("/project-a")?.index).toBe(1);
});
