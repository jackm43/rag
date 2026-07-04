export type AttestedArtifact = {
  path: string;
  sha256: string;
  githubBlobSha: string;
};

export type GitHubAttestationScope = "production" | "pull_request" | "branch";

export type GitHubAttestation = {
  id: string;
  repository: string;
  owner: string;
  repo: string;
  ref: string;
  commitSha: string;
  scope: GitHubAttestationScope;
  pullRequestNumber?: number;
  branchName?: string;
  actorLogin?: string;
  actorId?: number;
  receivedAt: string;
  eventId?: string;
  artifacts: AttestedArtifact[];
};

export type AttestationVerification = {
  ok: boolean;
  attestation?: GitHubAttestation;
};

export type VerifyArtifactInput = {
  repository: string;
  path: string;
  sha256: string;
  commitSha?: string;
  ref?: string;
  productionOnly?: boolean;
  actorLogin?: string;
};
