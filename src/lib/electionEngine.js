export function toIsoOffset(hours) {
  const date = new Date();
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

export function getElectionStatus(election, now = new Date()) {
  if (!election.published) return "draft";

  const start = new Date(election.startAt);
  const end = new Date(election.endAt);

  if (now < start) return "upcoming";
  if (now >= start && now <= end) return "active";
  return "completed";
}

export function isRegistrationOpen(election, now = new Date()) {
  return (
    election.published &&
    now <= new Date(election.registrationDeadline) &&
    election.registrations.length < election.maxVoters
  );
}

export function shouldAutoLock(election, now = new Date()) {
  return (
    election.published &&
    !election.locked &&
    (election.registrations.length >= election.maxVoters || now > new Date(election.registrationDeadline))
  );
}

export function canVote(election, now = new Date()) {
  return getElectionStatus(election, now) === "active" && election.locked && election.resultLocked !== true;
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatCountdown(targetValue, now = new Date()) {
  const target = new Date(targetValue);
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const prefix = diff < 0 ? "Ended" : "Remaining";

  if (days > 0) return `${prefix}: ${days}d ${hours}h`;
  if (hours > 0) return `${prefix}: ${hours}h ${minutes}m`;
  return `${prefix}: ${minutes}m ${seconds}s`;
}

export function maskSecretId(secretId) {
  if (!secretId) return "Not issued";
  return `****${secretId.slice(-4)}`;
}

export function getVoteTotal(election) {
  return Object.values(election.votes).reduce((sum, count) => sum + count, 0);
}

export function getResults(election) {
  const total = getVoteTotal(election);

  return election.candidates
    .map((candidate) => {
      const votes = election.votes[candidate.id] ?? 0;
      return {
        ...candidate,
        votes,
        percent: total > 0 ? Math.round((votes / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.votes - a.votes);
}

export function getWinner(election) {
  const results = getResults(election);
  if (!results.length || results[0].votes === 0) return null;
  return results[0];
}

export function getTurnout(election) {
  const finalCount = election.finalizedVoterCount || election.registrations.length || election.maxVoters;
  if (!finalCount) return 0;
  return Math.round((getVoteTotal(election) / finalCount) * 100);
}

export function buildAuditLog(action, actor, detail) {
  return {
    id: crypto.randomUUID(),
    action,
    actor,
    detail,
    createdAt: new Date().toISOString(),
    ipAddress: "demo-client",
  };
}

export function generateSecretId(election, voterId, index) {
  const prefix = election.codePrefix || election.id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const ordinal = String(index + 1).padStart(4, "0");
  const checksum = voterId.slice(-4).toUpperCase();
  return `${prefix}-${ordinal}-${checksum}`;
}
