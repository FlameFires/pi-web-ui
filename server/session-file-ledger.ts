import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic-file.js";
import { sessionLines } from "./session-scan.js";
import { collectSessionChangedFiles } from "./session-file-changes.js";
import { cumulativePatch, type CumulativeEvidence } from "./session-file-evidence.js";
import type {
	SessionFileLedgerIdentity,
	SessionFileLedgerFile,
	SessionFileLedgerOperation,
	SessionFileLedgerPage,
	UiMessage,
} from "./protocol.js";

const PAGE_BYTES = 48 * 1024;
const RAW_BYTES = 2 * 1024 * 1024;
const PAGE_COUNT = 30;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const queues = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(action);
	queues.set(key, next);
	try {
		return await next;
	} finally {
		if (queues.get(key) === next) queues.delete(key);
	}
}
async function json<T>(file: string, fallback: T, max = RAW_BYTES): Promise<T> {
	try {
		if ((await stat(file)).size > max) throw new Error("Ledger record exceeds byte budget");
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}
async function namesPage(dir: string, after: string, count = PAGE_COUNT + 1): Promise<string[]> {
	const selected: string[] = [];
	try {
		for await (const entry of await opendir(dir)) {
			if (!entry.isFile() || !/^\d{16}\.json$/.test(entry.name) || entry.name <= after) continue;
			selected.push(entry.name);
			selected.sort();
			if (selected.length > count) selected.pop();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return selected;
}
interface FileRecord extends SessionFileLedgerFile {
	key: string;
	lastTimestamp: number;
}
interface StoredOperation {
	operation: SessionFileLedgerOperation;
	raw: string;
}
interface Head {
	version: number;
	sequence: number;
	backfilled: boolean;
	partial?: boolean;
}
interface Transaction {
	path: string;
	key: string;
	operation: SessionFileLedgerOperation;
	summary: FileRecord;
	evidence: CumulativeEvidence;
}
export class SessionFileLedger {
	readonly directory: string;
	constructor(
		dataDir: string,
		readonly identity: SessionFileLedgerIdentity,
	) {
		this.directory = join(dataDir, "session-file-ledger", hash(identity.sessionFile + "\0" + identity.cwd));
	}
	private fileKey(path: string): string {
		const windows = /^(?:[a-z]:|\/\/)/i.test(this.identity.cwd.replaceAll("\\", "/")) || /^(?:[a-z]:|\/\/)/i.test(path);
		return hash(windows ? path.toLowerCase() : path);
	}
	private async head(): Promise<Head> {
		return json(join(this.directory, "head.json"), { version: 1, sequence: 0, backfilled: false });
	}
	private async recover(): Promise<void> {
		const transaction = await json<Transaction | null>(join(this.directory, "pending.json"), null, 8 * RAW_BYTES);
		if (!transaction) return;
		const { path, key, operation, summary, evidence } = transaction;
		const fileDir = join(this.directory, "files", this.fileKey(path));
		await mkdir(join(fileDir, "operations"), { recursive: true });
		await writeAtomic(join(fileDir, key), JSON.stringify(operation));
		const { argumentsText: _args, details: _details, output: _output, ...metadata } = operation;
		await writeAtomic(
			join(fileDir, "operations", key),
			JSON.stringify({ operation: { ...metadata, output: "" }, raw: key }),
		);
		await writeAtomic(join(fileDir, "evidence.json"), JSON.stringify(evidence));
		await writeAtomic(join(fileDir, "summary.json"), JSON.stringify(summary));
		await mkdir(join(this.directory, "list"), { recursive: true });
		await writeAtomic(join(this.directory, "list", summary.key), JSON.stringify({ path }));
		await writeAtomic(join(fileDir, hash(operation.id) + ".json"), JSON.stringify({ key }));
		await rm(join(this.directory, "pending.json"));
	}
	async append(messages: readonly UiMessage[], evidence?: CumulativeEvidence): Promise<boolean> {
		const files = collectSessionChangedFiles(messages, this.identity.cwd);
		if (!files.length) return false;
		return serial(this.directory, async () => {
			await mkdir(this.directory, { recursive: true });
			await this.recover();
			const head = await this.head();
			let changed = false;
			for (const file of files) {
				if (Buffer.byteLength(file.path) > 4096) continue;
				const fileDir = join(this.directory, "files", this.fileKey(file.path));
				let summary = await json<FileRecord | null>(join(fileDir, "summary.json"), null);
				let cumulative = await json<CumulativeEvidence>(join(fileDir, "evidence.json"), {
					before: { available: false },
					after: { available: false },
				});
				for (const operation of file.operations) {
					if (await json(join(fileDir, hash(operation.id) + ".json"), null)) continue;
					if (
						evidence?.before.available &&
						evidence.after.available &&
						evidence.before.text === evidence.after.text &&
						evidence.before.exists === evidence.after.exists
					)
						continue;
					const key = `${String(++head.sequence).padStart(16, "0")}.json`;
					const raw = JSON.stringify(operation);
					const stored =
						Buffer.byteLength(raw) <= RAW_BYTES
							? operation
							: {
									...operation,
									argumentsText: undefined,
									details: undefined,
									output: "Operation content exceeds 2 MiB; payload unavailable.",
									truncated: true,
								};
					const timestamp = operation.timestamp ?? 0;
					const first = !summary;
					summary = summary ?? {
						path: file.path,
						kind: file.kind,
						status: file.status,
						operationCount: 0,
						key,
						lastTimestamp: timestamp,
					};
					summary.operationCount++;
					if (timestamp >= summary.lastTimestamp) {
						summary.status = file.status;
						summary.lastTimestamp = timestamp;
					}
					const continuous =
						cumulative.after.available &&
						evidence?.before.available &&
						cumulative.after.text === evidence.before.text &&
						cumulative.after.exists === evidence.before.exists;
					cumulative =
						first && evidence
							? evidence
							: {
									before: continuous ? cumulative.before : { available: false },
									after: evidence?.after ?? { available: false },
								};
					if (first && evidence?.before.available) stored.label = evidence.before.exists ? "edited" : "created";
					await writeAtomic(join(this.directory, "head.json"), JSON.stringify(head));
					await writeAtomic(
						join(this.directory, "pending.json"),
						JSON.stringify({
							path: file.path,
							key,
							operation: stored,
							summary,
							evidence: cumulative,
						} satisfies Transaction),
					);
					await this.recover();
					changed = true;
				}
			}
			return changed;
		});
	}
	async backfill(enabled: () => boolean = () => true): Promise<boolean> {
		if ((await this.head()).backfilled) return false;
		const calls = new Map<string, UiMessage>();
		let callBytes = 0;
		let partial = false;
		for await (const line of sessionLines(this.identity.sessionFile)) {
			if (!enabled()) return false;
			if (Buffer.byteLength(line) > RAW_BYTES) {
				partial = true;
				continue;
			}
			let entry: { message?: Record<string, unknown> };
			try {
				entry = JSON.parse(line);
			} catch {
				partial = true;
				continue;
			}
			const message = entry.message;
			if (!message) continue;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const raw of message.content) {
					const block = raw as Record<string, unknown>;
					if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
					const argumentsText = JSON.stringify(block.arguments ?? {});
					if (Buffer.byteLength(argumentsText) > RAW_BYTES) {
						partial = true;
						continue;
					}
					const call: UiMessage = {
						id: block.id,
						role: "assistant",
						content: [{ type: "toolCall", id: block.id, name: block.name, argumentsText }],
					};
					calls.set(block.id, call);
					callBytes += Buffer.byteLength(argumentsText);
					if (calls.size > 256 || callBytes > 4 * RAW_BYTES) {
						partial = true;
						calls.clear();
						callBytes = 0;
					}
				}
			}
			if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				const call = calls.get(message.toolCallId);
				const result: UiMessage = {
					id: message.toolCallId,
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: typeof message.toolName === "string" ? message.toolName : undefined,
					isError: message.isError === true,
					details: message.details,
					timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
					content: Array.isArray(message.content) ? (message.content as UiMessage["content"]) : [],
				};
				await this.append(call ? [call, result] : [result]);
				calls.delete(message.toolCallId);
			}
		}
		await serial(this.directory, async () => {
			const head = await this.head();
			head.backfilled = true;
			head.partial = partial || calls.size > 0;
			await writeAtomic(join(this.directory, "head.json"), JSON.stringify(head));
		});
		return true;
	}
	async page(
		reqId: string,
		path?: string,
		cursor?: string,
		options: { operationId?: string; offset?: number; cumulative?: boolean } = {},
	): Promise<SessionFileLedgerPage> {
		await serial(this.directory, () => this.recover());
		if (cursor && cursor.length > 1024) throw new Error("Invalid ledger cursor");
		const offset = options.offset ?? 0;
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * RAW_BYTES)
			throw new Error("Invalid content offset");
		const scope = hash(this.identity.sessionFile + "\0" + this.identity.cwd + "\0" + (path ?? ""));
		let after = "";
		if (cursor) {
			const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
			if (decoded.scope !== scope || !/^\d{16}\.json$/.test(decoded.after)) throw new Error("Invalid ledger cursor");
			after = decoded.after;
		}
		const head = await this.head();
		const result: SessionFileLedgerPage = {
			...this.identity,
			reqId,
			path,
			files: [],
			operations: [],
			coverage: head.backfilled ? (head.partial ? "partial-transcript" : "available-transcript") : "recorded-only",
			cumulative: {
				status: "unavailable",
				reason:
					"Complete first-before and latest-after evidence is unavailable; operation patches cover only their recorded ranges.",
			},
		};
		if (path !== undefined) {
			const fileDir = join(this.directory, "files", this.fileKey(path));
			const evidence = await json<CumulativeEvidence>(join(fileDir, "evidence.json"), {
				before: { available: false },
				after: { available: false },
			});
			const patch = cumulativePatch(path, evidence);
			if (patch !== undefined)
				result.cumulative = {
					status: "exact",
					patch: patch.slice(options.cumulative ? offset : 0, (options.cumulative ? offset : 0) + 4096),
					...(patch.length > (options.cumulative ? offset : 0) + 4096
						? { nextOffset: (options.cumulative ? offset : 0) + 4096 }
						: {}),
				};
			if (options.cumulative) return result;
			if (options.operationId) {
				const marker = await json<{ key: string } | null>(join(fileDir, hash(options.operationId) + ".json"), null);
				if (!marker) throw new Error("Operation not found");
				const operation = await json<SessionFileLedgerOperation | null>(join(fileDir, marker.key), null);
				if (!operation) throw new Error("Operation payload not found");
				const raw = JSON.stringify(operation, null, 2);
				result.operationId = options.operationId;
				result.rawText = raw.slice(offset, offset + 4096);
				if (raw.length > offset + 4096) result.nextOffset = offset + 4096;
				return result;
			}
		}
		const dir =
			path === undefined
				? join(this.directory, "list")
				: join(this.directory, "files", this.fileKey(path), "operations");
		const names = await namesPage(dir, after);
		let last = after;
		for (const name of names) {
			if (result.files.length + result.operations.length >= PAGE_COUNT) break;
			if (path === undefined) {
				const item = await json<{ path: string } | null>(join(dir, name), null);
				if (!item) continue;
				const summary = await json<FileRecord | null>(
					join(this.directory, "files", this.fileKey(item.path), "summary.json"),
					null,
				);
				if (!summary) continue;
				const { key: _key, lastTimestamp: _timestamp, ...file } = summary;
				result.files.push(file);
			} else {
				const item = await json<StoredOperation | null>(join(dir, name), null);
				if (!item) continue;
				let operation = await json<SessionFileLedgerOperation>(
					join(this.directory, "files", this.fileKey(path), item.raw),
					item.operation,
				);
				if (Buffer.byteLength(JSON.stringify(operation)) > 24 * 1024)
					operation = {
						...item.operation,
						output: "Operation payload exceeds the display byte budget; recorded payload is retained on disk.",
						truncated: true,
					};
				result.operations.push(operation);
			}
			if (Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES) {
				if (path === undefined) result.files.pop();
				else result.operations.pop();
				break;
			}
			last = name;
		}
		if (names.some((name) => name > last))
			result.nextCursor = Buffer.from(JSON.stringify({ scope, after: last })).toString("base64url");
		return result;
	}
}
