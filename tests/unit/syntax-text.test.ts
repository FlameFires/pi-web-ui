// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SyntaxText } from "../../web/src/components/SyntaxText";

it("renders syntax tokens while preserving source text", async () => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	const root = createRoot(container);
	const text = 'const greeting = "hello";';
	await act(async () => {
		root.render(createElement(SyntaxText, { text, language: "javascript" }));
	});
	await act(async () => {
		await import("lowlight");
	});
	expect(container.textContent).toBe(text);
	expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
	expect(container.querySelector(".hljs-string")?.textContent).toBe('"hello"');
	act(() => root.unmount());
});
