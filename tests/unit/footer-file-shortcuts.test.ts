import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FooterBar } from "../../web/src/components/FooterBar.js";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../web/src/app-globals", () => ({ appSend: vi.fn(), useAppField: () => [] }));
vi.mock("../../web/src/components/ProjectPicker.js", () => ({ ProjectPicker: () => null }));
vi.mock("../../web/src/components/BarItem", () => ({ BarItem: () => null }));
vi.mock("../../web/src/components/SessionChangedFiles", () => ({
	SessionChangedFiles: () => createElement("span", { "data-files": true }, "Changes"),
}));

function render(settings: Record<string, boolean> = {}) {
	return renderToStaticMarkup(
		createElement(FooterBar, {
			chat: { settings, state: { cwd: "/repo" } } as any,
			bottombarItems: [],
			recentPreview: { files: [{ path: "/repo/main.ts", name: "main.ts" }], index: 0 } as any,
			onReopenPreview: () => {},
		}),
	);
}
describe("footer file shortcuts", () => {
	it("renders both shortcuts on the right by default", () => {
		const html = render();
		expect(html).toContain('<div class="statusbar-left"></div>');
		expect(html.indexOf("statusbar-preview")).toBeGreaterThan(html.indexOf("statusbar-right"));
		expect(html.indexOf("data-files")).toBeGreaterThan(html.indexOf("statusbar-right"));
	});
	it("toggles each shortcut independently", () => {
		const previewOff = render({ filePreviewRestoreEnabled: false });
		expect(previewOff).not.toContain("statusbar-preview");
		expect(previewOff).toContain("data-files");
		const changesOff = render({ sessionChangedFilesEnabled: false });
		expect(changesOff).toContain("statusbar-preview");
		expect(changesOff).not.toContain("data-files");
	});
});
