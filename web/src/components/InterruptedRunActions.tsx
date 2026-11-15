import { useEffect, useState } from "react";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { Notice } from "../use-chat";

export function InterruptedRunActions({ runs }: { runs: NonNullable<Notice["interruptedRuns"]> }) {
	const t = useT();
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	const [sendFailed, setSendFailed] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		setPending((current) => {
			const next = new Set(current);
			for (const run of runs) if (run.resumed || run.error) next.delete(run.runId);
			return next.size === current.size ? current : next;
		});
	}, [runs]);
	const resume = (ids: string[]) => {
		setPending((current) => new Set([...current, ...ids]));
		for (const runId of ids) {
			if (!appSend({ type: "resume_interrupted_subagent", runId })) {
				setSendFailed((current) => new Set([...current, runId]));
				setPending((current) => {
					const next = new Set(current);
					next.delete(runId);
					return next;
				});
			}
		}
	};
	const available = runs.filter((run) => !run.resumed && !pending.has(run.runId));
	return (
		<div className="interrupted-runs" onClick={(event) => event.stopPropagation()}>
			{runs.map((run) => (
				<div className="interrupted-run" key={run.runId}>
					<span className="interrupted-run-title" title={run.title}>
						{run.title}
					</span>
					{run.resumed ? (
						<span className="interrupted-run-state">{t("restartRecovery.resumed")}</span>
					) : (
						<button
							type="button"
							className="btn sm"
							disabled={pending.has(run.runId)}
							onClick={() => resume([run.runId])}
						>
							{pending.has(run.runId)
								? t("restartRecovery.resuming")
								: run.error
									? t("restartRecovery.retry")
									: t("restartRecovery.resume")}
						</button>
					)}
					{!run.resumed && (run.error || sendFailed.has(run.runId)) && !pending.has(run.runId) && (
						<span className="interrupted-run-error" role="status">
							{t("restartRecovery.failed")}
						</span>
					)}
				</div>
			))}
			{runs.length > 1 && (
				<button
					type="button"
					className="btn sm"
					disabled={!available.length}
					onClick={() => resume(available.map((run) => run.runId))}
				>
					{t("restartRecovery.resumeAll")}
				</button>
			)}
		</div>
	);
}
