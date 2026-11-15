import { open } from "node:fs/promises";
export type FileEvidence = { available: true; text: string; exists: boolean } | { available: false };
export async function captureFileEvidence(path: string): Promise<FileEvidence> {
	try {
		const file = await open(path, "r");
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > 256 * 1024) return { available: false };
			const data = Buffer.alloc(256 * 1024 + 1);
			const { bytesRead } = await file.read(data, 0, data.length, 0);
			const after = await file.stat();
			if (
				bytesRead !== info.size ||
				after.size !== info.size ||
				after.mtimeMs !== info.mtimeMs ||
				bytesRead > 256 * 1024 ||
				data.subarray(0, bytesRead).includes(0)
			)
				return { available: false };
			const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead));
			return { available: true, exists: true, text };
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { available: true, exists: false, text: "" };
		return { available: false };
	}
}
export interface CumulativeEvidence {
	before: FileEvidence;
	after: FileEvidence;
}
export function cumulativePatch(path: string, evidence: CumulativeEvidence): string | undefined {
	if (!evidence.before.available || !evidence.after.available) return;
	const before = evidence.before.text;
	const after = evidence.after.text;
	if (before === after && evidence.before.exists === evidence.after.exists) return "";
	const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);
	const oldLines = lines(before),
		newLines = lines(after);
	const body = [...oldLines.map((line) => "-" + line), ...newLines.map((line) => "+" + line)];
	if (before && !before.endsWith("\n")) body.splice(oldLines.length, 0, "\\ No newline at end of file");
	if (after && !after.endsWith("\n")) body.push("\\ No newline at end of file");
	return `--- ${evidence.before.exists ? "a/" + path : "/dev/null"}\n+++ ${evidence.after.exists ? "b/" + path : "/dev/null"}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${body.join("\n")}\n`;
}
