import { createContext, useContext, createElement, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Element, RootContent } from "hast";

type Highlighter = ReturnType<(typeof import("lowlight"))["createLowlight"]>;
let highlighter: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;
const cache = new Map<string, ReactNode>();
export const SyntaxLanguageContext = createContext("plaintext");

function renderNode(node: RootContent, key: number): ReactNode {
	if (node.type === "text") return node.value;
	if (node.type !== "element") return null;
	const element = node as Element;
	const className = element.properties.className;
	return createElement(
		"span",
		{ key, className: Array.isArray(className) ? className.join(" ") : undefined },
		element.children.map(renderNode),
	);
}

export const SyntaxText = memo(function SyntaxText({
	text,
	language: specifiedLanguage,
}: {
	text: string;
	language?: string;
}) {
	const inheritedLanguage = useContext(SyntaxLanguageContext);
	const language = specifiedLanguage ?? inheritedLanguage;
	const [ready, setReady] = useState(!!highlighter);
	useEffect(() => {
		if (language === "plaintext" || ready) return;
		let active = true;
		loading ??= import("lowlight").then(({ createLowlight, common }) => (highlighter = createLowlight(common)));
		void loading
			.then(() => {
				if (active) setReady(true);
			})
			.catch(() => {
				loading = undefined;
			});
		return () => {
			active = false;
		};
	}, [language, ready]);
	const content = useMemo(() => {
		if (!ready || !highlighter?.registered(language) || text.length > 10000) return text;
		const key = `${language}\0${text}`;
		if (cache.has(key)) return cache.get(key);
		try {
			const result = highlighter.highlight(language, text).children.map(renderNode);
			if (cache.size >= 500) cache.delete(cache.keys().next().value!);
			cache.set(key, result);
			return result;
		} catch {
			return text;
		}
	}, [text, language, ready]);
	return <span className="syntax-text">{content}</span>;
});
