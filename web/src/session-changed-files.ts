import type { UiMessage, UiToolCallBlock } from "./types";

export interface SessionFileOperation {
	id: string;
	toolName: string;
	kind?: "file" | "dir";
	argumentsText?: string;
	details?: unknown;
	output: string;
	timestamp?: number;
	label?: "created" | "edited" | "deleted" | "moved";
}

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

function pathKey(value: string, workspace: string): string {
	const path = normalizePath(value, workspace);
	return /^[a-z]:/i.test(path) || path.startsWith("//") || /^[a-z]:/i.test(workspace) || workspace.startsWith("//")
		? path.toLowerCase()
		: path;
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

function commandSegments(command: string): string[][] {
	const segments: string[][] = [[]];
	let token = "";
	let quote = "";
	let escaped = false;
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

interface ShellFileMutation {
	cwd: string;
	kind: "delete" | "move";
	paths: string[];
}
function shellFileMutations(command: string, workspace: string): ShellFileMutation[] {
	let cwd = workspace;
	const mutations: ShellFileMutation[] = [];
	for (const segment of commandSegments(command)) {
		const executable = segment[0].split(/[\\/]/).at(-1)?.toLowerCase();
		if (executable === "cd" && segment[1]) {
			cwd = normalizePath(segment[1], cwd);
			continue;
		}
		if (executable === "rm" || executable === "del" || executable === "erase") {
			const paths = segment.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-") && !/[?*\[\]]/.test(arg));
			if (paths.length) mutations.push({ cwd, kind: "delete", paths });
			continue;
		}
		if (executable === "rmdir") {
			const paths = segment.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-") && !/[?*\[\]]/.test(arg));
			if (paths.length) mutations.push({ cwd, kind: "delete", paths: paths.map((path) => `\u0000dir:${path}`) });
			continue;
		}
		if (executable === "mv" || executable === "move") {
			const paths = segment.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-") && !/[?*\[\]]/.test(arg));
			if (paths.length >= 2) mutations.push({ cwd, kind: "move", paths: paths.slice(0, 2) });
		}
	}
	return mutations;
}

export function collectSessionChangedFiles(messages: readonly UiMessage[], workspace: string): SessionChangedFile[] {
	const calls = new Map<string, UiToolCallBlock>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string")
				calls.set(block.id, block as UiToolCallBlock);
		}
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
		const rawPath = pathInput.startsWith("\u0000dir:") ? pathInput.slice(5) : pathInput;
		const normalizedInput = pathInput.startsWith("\u0000dir:") ? `${rawPath}/` : pathInput;
		const path = normalizePath(normalizedInput, base);
		if (pathInput.startsWith("\u0000dir:")) kind = "dir";
		const key = pathKey(path, workspace);

		const file = files.get(key) ?? {
			path: normalizePath(pathInput.startsWith("\u0000dir:") ? `${pathInput.slice(5)}/` : pathInput, base),
			kind,
			status: "present" as const,
			operations: [],
		};
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
					const path = string(string(result.filePath).replaceAll("\\", "/"));
					if (path)
						targets.push({
							path,
							status: result.op === "deleted" ? "deleted" : result.op === "moved" ? "moved" : "present",
							label: result.op === "deleted" ? "deleted" : result.op === "moved" ? "moved" : "edited",
							kind: "file",
						});
					if (result.op === "moved" && string(result.newPath).replaceAll("\\", "/"))
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
					string(args.filePath)
				).replaceAll("\\", "/");
				if (path)
					targets.push({ path, status: "present", label: toolName === "write" ? "created" : "edited", kind: "file" });
			}
		} else if (toolName === "bash") {
			const command = string(args.command) || string(args.script);
			const result = record(message.details);
			if (typeof result.exitCode === "number" && result.exitCode !== 0) continue;
			for (const mutation of shellFileMutations(command, workspace)) {
				if (mutation.kind === "delete")
					for (const path of mutation.paths) {
						const isDirectory = path.startsWith("\u0000dir:");
						const targetPath = isDirectory ? path.slice(5) : path;
						targets.push({
							path: targetPath,
							status: "deleted",
							label: "deleted",
							kind: isDirectory ? "dir" : "file",
							base: mutation.cwd,
						});
					}
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
		for (const target of targets) {
			const operation: SessionFileOperation = {
				id: message.toolCallId,
				toolName,
				argumentsText: call?.argumentsText,
				details: message.details,
				output,
				timestamp: message.timestamp,
				label: target.label,
				kind: target.kind,
			};
			apply(target.path, target.status, operation, target.base ?? workspace, target.kind);
		}
	}
	return [...files.values()].sort(
		(a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || a.path.localeCompare(b.path),
	);
}
