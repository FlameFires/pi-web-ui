import type { UiMessage, UiToolCallBlock } from "./protocol.js";

export type SessionFileOperation = import("./protocol.js").SessionFileLedgerOperation;
export type SessionFileStatus = "present" | "deleted" | "moved";
export interface SessionChangedFile {
	path: string;
	kind: "file" | "dir";
	status: SessionFileStatus;
	operations: SessionFileOperation[];
}
const FILE_MUTATIONS = new Set([
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
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
function decodeQuotedPath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) return value;
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	const inner = value.slice(1, -1);
	const escapes: Record<string, string> = {
		a: "\x07",
		b: "\b",
		t: "\t",
		n: "\n",
		v: "\v",
		f: "\f",
		r: "\r",
		'"': '"',
		"\\": "\\",
	};
	for (let i = 0; i < inner.length;) {
		if (inner[i] === "\\") {
			const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
			if (octal) {
				const byte = parseInt(octal[0], 8);
				if (byte > 255) return value;
				bytes.push(byte);
				i += octal[0].length + 1;
				continue;
			}
			const decoded = escapes[inner[i + 1]];
			if (decoded === undefined) return value;
			bytes.push(...encoder.encode(decoded));
			i += 2;
		} else {
			const point = String.fromCodePoint(inner.codePointAt(i)!);
			bytes.push(...encoder.encode(point));
			i += point.length;
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
	} catch {
		return value;
	}
}
export function diffHeaderPath(details: unknown): string {
	const value = record(details);
	for (const key of ["patch", "diff"]) {
		for (const line of string(value[key]).split("\n")) {
			const match = /^(?:\+\+\+|---)\s+(.+)$/.exec(line);
			if (!match) continue;
			const raw = match[1].split("\t", 1)[0].trim();
			const candidate = decodeQuotedPath(raw).replace(/^[abciow]\//, "");
			if (candidate && candidate !== "/dev/null") return candidate;
		}
	}
	return "";
}
function normalizePath(path: string, cwd: string): string {
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
	return base && (comparable === prefix || comparable.startsWith(prefix + "/"))
		? full.slice(base.length + (comparable === prefix ? 0 : 1))
		: full;
}
function pathKey(value: string, workspace: string): string {
	const path = normalizePath(value, workspace);
	return /^[a-z]:/i.test(path) || path.startsWith("//") || /^[a-z]:/i.test(workspace) || workspace.startsWith("//")
		? path.toLowerCase()
		: path;
}
function commandSegments(command: string): string[][] {
	const segments: string[][] = [[]];
	let token = "",
		quote = "",
		escaped = false;
	const pushToken = () => {
		if (token) segments.at(-1)!.push(token);
		token = "";
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = "";
			else token += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if ((char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
			pushToken();
			segments.push([]);
			i++;
			continue;
		}
		if (char === ";" || char === "\n" || char === "|") {
			pushToken();
			segments.push([]);
			continue;
		}
		if (/\s/.test(char)) {
			pushToken();
			continue;
		}
		token += char;
	}
	pushToken();
	return segments.filter((segment) => segment.length > 0);
}
function shellFileMutations(
	command: string,
	workspace: string,
): { cwd: string; kind: "delete" | "move"; paths: string[] }[] {
	let cwd = workspace;
	const mutations: { cwd: string; kind: "delete" | "move"; paths: string[] }[] = [];
	for (const segment of commandSegments(command)) {
		const executable = segment[0].split(/[\\/]/).at(-1)?.toLowerCase();
		if (executable === "cd" && segment[1]) {
			cwd = normalizePath(segment[1], cwd);
			continue;
		}
		const paths = segment.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-") && !/[?*\[\]]/.test(arg));
		if (executable === "rm" || executable === "del" || executable === "erase") {
			if (paths.length) mutations.push({ cwd, kind: "delete", paths });
		}
		if (executable === "rmdir" && paths.length)
			mutations.push({ cwd, kind: "delete", paths: paths.map((path) => `\u0000dir:${path}`) });
		if ((executable === "mv" || executable === "move") && paths.length >= 2)
			mutations.push({ cwd, kind: "move", paths: paths.slice(0, 2) });
	}
	return mutations;
}
export function collectSessionChangedFiles(messages: readonly UiMessage[], workspace: string): SessionChangedFile[] {
	const calls = new Map<string, UiToolCallBlock>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content)
			if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string")
				calls.set(block.id, block as UiToolCallBlock);
	}
	const files = new Map<string, SessionChangedFile>();
	const seen = new Set<string>();
	const apply = (
		pathInput: string,
		status: SessionFileStatus,
		operation: SessionFileOperation,
		base = workspace,
		kind: "file" | "dir" = "file",
	) => {
		const isDir = pathInput.startsWith("\u0000dir:");
		const path = normalizePath(isDir ? `${pathInput.slice(5)}/` : pathInput, base);
		if (isDir) kind = "dir";
		const key = pathKey(path, workspace);
		const file = files.get(key) ?? { path, kind, status: "present" as const, operations: [] };
		file.status = status;
		file.kind = kind;
		if (!file.operations.some((item) => item.id === operation.id && item.label === operation.label)) {
			const index = file.operations.findIndex(
				(item) =>
					item.timestamp !== undefined && operation.timestamp !== undefined && item.timestamp > operation.timestamp,
			);
			file.operations.splice(index < 0 ? file.operations.length : index, 0, operation);
		}
		files.set(key, file);
	};
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.toolCallId || message.isError || seen.has(message.toolCallId))
			continue;
		const call = calls.get(message.toolCallId);
		const toolName = (call?.name ?? message.toolName ?? "").split(".").at(-1) ?? "";
		let args: Record<string, unknown> = {};
		try {
			args = record(JSON.parse(call?.argumentsText ?? "{}"));
		} catch {}
		const details = record(message.details);
		const output = message.content
			.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n");
		if (details.ok === false || details.classification === "noop" || /^No changes made\b/.test(output)) continue;
		const targets: {
			path: string;
			status: SessionFileStatus;
			label: SessionFileOperation["label"];
			kind: "file" | "dir";
			base?: string;
		}[] = [];
		if (FILE_MUTATIONS.has(toolName)) {
			if (toolName === "patch" && Array.isArray(details.results)) {
				for (const item of details.results) {
					const result = record(item);
					const path = string(result.filePath).replaceAll("\\", "/");
					if (path)
						targets.push({
							path,
							status: result.op === "deleted" ? "deleted" : result.op === "moved" ? "moved" : "present",
							label: result.op === "deleted" ? "deleted" : result.op === "moved" ? "moved" : "edited",
							kind: "file",
						});
					if (result.op === "moved" && string(result.newPath))
						targets.push({
							path: string(result.newPath).replaceAll("\\", "/"),
							status: "present",
							label: "moved",
							kind: "file",
						});
				}
			} else {
				const path = (
					string(details.path) ||
					string(args.path) ||
					string(args.file_path) ||
					string(args.filePath) ||
					diffHeaderPath(message.details)
				).replaceAll("\\", "/");
				if (path)
					targets.push({ path, status: "present", label: toolName === "write" ? "created" : "edited", kind: "file" });
			}
		} else if (toolName === "bash") {
			if (typeof details.exitCode === "number" && details.exitCode !== 0) continue;
			for (const mutation of shellFileMutations(string(args.command) || string(args.script), workspace)) {
				if (mutation.kind === "delete")
					for (const path of mutation.paths)
						targets.push({
							path: path.startsWith("\u0000dir:") ? path.slice(5) : path,
							status: "deleted",
							label: "deleted",
							kind: path.startsWith("\u0000dir:") ? "dir" : "file",
							base: mutation.cwd,
						});
				if (mutation.kind === "move") {
					const [source, destination] = mutation.paths;
					targets.push(
						{ path: source, status: "moved", label: "moved", kind: "file", base: mutation.cwd },
						{ path: destination, status: "present", label: "moved", kind: "file", base: mutation.cwd },
					);
				}
			}
		}
		if (!targets.length) continue;
		seen.add(message.toolCallId);
		for (const target of targets)
			apply(
				target.path,
				target.status,
				{
					id: message.toolCallId,
					toolName,
					argumentsText: call?.argumentsText,
					details: message.details,
					output,
					timestamp: message.timestamp,
					label: target.label,
					kind: target.kind,
				},
				target.base ?? workspace,
				target.kind,
			);
	}
	return [...files.values()].sort(
		(a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || a.path.localeCompare(b.path),
	);
}
