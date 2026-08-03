export interface SubjectTeam {
  id: string;
  name?: string | null;
}

export interface SubjectPerson {
  principalId: string;
  displayName?: string | null;
}

export interface SubjectDirectory {
  teams?: readonly SubjectTeam[] | null;
  people?: readonly SubjectPerson[] | null;
}

export type SubjectKind = "org" | "team" | "principal";

export interface SubjectLabel {
  kind: SubjectKind;
  chip: string;
  name: string;
  id: string;
  known: boolean;
  orphaned: boolean;
}

export function subjectLabel(subject: string, dir: SubjectDirectory = {}): SubjectLabel {
  if (subject === "org") {
    return { kind: "org", chip: "ORG", name: "Whole organization", id: "", known: true, orphaned: false };
  }
  if (subject.startsWith("team:")) {
    const id = subject.slice(5);
    const team = (dir.teams ?? []).find((t) => t.id === id) ?? null;
    return {
      kind: "team",
      chip: "TEAM",
      name: team?.name || id,
      id,
      known: !!team,
      orphaned: !!dir.teams && !team,
    };
  }
  if (subject.startsWith("principal:")) {
    const id = subject.slice(10);
    const person = (dir.people ?? []).find((p) => p.principalId === id) ?? null;
    return {
      kind: "principal",
      chip: "PERSON",
      name: person?.displayName || id,
      id,
      known: !!person,
      orphaned: !!dir.people && !person,
    };
  }
  return { kind: "principal", chip: "PERSON", name: subject, id: subject, known: false, orphaned: false };
}

export function teamLabel(teamId: string, dir: SubjectDirectory = {}): SubjectLabel {
  return subjectLabel(`team:${teamId}`, dir);
}
