import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeAtomic } from "./atomic-file.js";

const BOOT_ID = randomUUID();
const queues = new Map<string, Promise<void>>();
export interface MainRunMarker {
	bootId: string;
	sessionFile: string;
	cwd: string;
	title: string;
}
function markerPath(dataDir: string, sessionFile: string): string {
	return join(dataDir, "main-session-runs", createHash("sha256").update(resolve(sessionFile)).digest("hex") + ".json");
}
function serial(path: string, action: () => Promise<void>): Promise<void> {
	const task = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(action);
	queues.set(path, task);
	void task
		.finally(() => {
			if (queues.get(path) === task) queues.delete(path);
		})
		.catch(() => {});
	return task;
}
export function markMainRun(dataDir: string, marker: Omit<MainRunMarker, "bootId">): Promise<void> {
	const path = markerPath(dataDir, marker.sessionFile);
	return serial(path, async () => {
		await mkdir(join(dataDir, "main-session-runs"), { recursive: true });
		await writeAtomic(path, JSON.stringify({ ...marker, bootId: BOOT_ID }));
	});
}
export function settleMainRun(dataDir: string, sessionFile: string): Promise<void> {
	const path = markerPath(dataDir, sessionFile);
	return serial(path, async () => {
		await unlink(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	});
}
export async function interruptedMainRun(dataDir: string, sessionFile: string): Promise<MainRunMarker | undefined> {
	const path = markerPath(dataDir, sessionFile);
	await queues.get(path)?.catch(() => {});
	try {
		const marker = JSON.parse(await readFile(path, "utf8")) as MainRunMarker;
		if (
			marker.bootId !== BOOT_ID &&
			typeof marker.bootId === "string" &&
			marker.sessionFile === sessionFile &&
			typeof marker.cwd === "string" &&
			typeof marker.title === "string"
		)
			return marker;
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return undefined;
}
