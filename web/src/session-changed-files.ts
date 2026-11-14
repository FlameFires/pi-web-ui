import type { UiMessage, UiToolCallBlock } from "./types";

export interface SessionFileOperation {
	id: string;
	toolName: string;
	argumentsText?: string;
	details?: unknown;
	output: string;
	timestamp?: number;
}

export interface SessionChangedFile {
	path: string;
	deleted: boolean;
	operations: SessionFileOperation[];
}

const MUTATIONS = new Set([
	"write",
	"edit",
	"patch",
	"replace",
	"replace_match",
	"insert",
	"copy",
	"move",
	"undo_last_change",
]);
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function normalizedPath(path: string, cwd: string): string {
	const clean = (value: string) => {
		const parts: string[] = [];
		const slashed = value.replaceAll("\\", "/");
		for (const part of slashed.split("/")) {
			if (!part || part === ".") continue;
			if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
			else parts.push(part);
		}
		return (slashed.startsWith("//") ? "//" : slashed.startsWith("/") ? "/" : "") + parts.join("/");
	};
	const absolute = /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path);
	const full = clean(absolute || !cwd ? path : `${cwd}/${path}`);
	const base = clean(cwd).replace(/\/$/, "");
	const windows = /^[a-z]:/i.test(full) || full.startsWith("//");
	const comparable = windows ? full.toLowerCase() : full;
	const prefix = windows ? base.toLowerCase() : base;
	return base && comparable.startsWith(prefix + "/") ? full.slice(base.length + 1) : full;
}

export function collectSessionChangedFiles(messages: readonly UiMessage[], cwd: string): SessionChangedFile[] {
	const calls = new Map<string, UiToolCallBlock>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
				calls.set(block.id, block as UiToolCallBlock);
			}
		}
	}
	const files = new Map<string, SessionChangedFile>();
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.toolCallId || message.isError || seen.has(message.toolCallId))
			continue;
		const call = calls.get(message.toolCallId);
		const toolName = (call?.name ?? message.toolName ?? "").split(".").at(-1) ?? "";
		if (!MUTATIONS.has(toolName)) continue;
		let args: Record<string, unknown> = {};
		try {
			args = record(JSON.parse(call?.argumentsText ?? "{}"));
		} catch {}
		const details = record(message.details);
		const output = message.content
			.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n");
		if (details.ok === false || details.classification === "noop" || /^No changes made\b/.test(output)) continue;
		const targets: { path: string; deleted: boolean }[] = [];
		if (toolName === "patch" && Array.isArray(details.results)) {
			for (const item of details.results) {
				const result = record(item);
				const path = string(result.filePath);
				if (path) targets.push({ path, deleted: result.op === "deleted" || result.op === "moved" });
				if (result.op === "moved" && string(result.newPath))
					targets.push({ path: string(result.newPath), deleted: false });
			}
		} else {
			const path = string(details.path) || string(args.path) || string(args.file_path) || string(args.filePath);
			if (path) targets.push({ path, deleted: false });
		}
		seen.add(message.toolCallId);
		const operation: SessionFileOperation = {
			id: message.toolCallId,
			toolName,
			argumentsText: call?.argumentsText,
			details: message.details,
			output,
			timestamp: message.timestamp,
		};
		for (const target of targets) {
			const path = normalizedPath(target.path, cwd);
			const key = /^[a-z]:/i.test(cwd) || cwd.startsWith("//") ? path.toLowerCase() : path;
			const file = files.get(key) ?? { path, deleted: false, operations: [] };
			file.deleted = target.deleted;
			if (!file.operations.some((op) => op.id === operation.id)) file.operations.push(operation);
			files.set(key, file);
		}
	}
	return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
