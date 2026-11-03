type RepairJob = {
  status: string;
  error?: string;
  repaired?: boolean;
  repair?: { attempted?: boolean; accepted?: boolean; inProgress?: boolean; rounds?: number };
};

/** Old jobs stay silent; a terminal failure overrides a leftover in-progress flag. */
export function pipelineRepairStatus(job: RepairJob): { message: string; failed: boolean } | null {
  if (job.repaired && job.repair?.accepted) {
    const rounds = job.repair.rounds;
    const count = typeof rounds === "number" ? ` — ${rounds} ${rounds === 1 ? "round" : "rounds"}` : "";
    return { failed: false, message: `Repaired automatically after the first pass failed validation${count}; nothing marked missing was filled.` };
  }
  if (!job.repair?.attempted || job.repair.accepted) return null;
  if (job.repair.inProgress) {
    return job.status === "failed" ? { failed: true, message: "Automatic repair did not finish." } : null;
  }
  // The failed view already shows job.error in its error box.
  const detail = job.status !== "failed" && job.error ? `: ${job.error}` : ".";
  return { failed: true, message: `Automatic repair did not succeed${detail}` };
}
