import type { Env } from "../contracts/types";
import type { AttestationVerification, VerifyArtifactInput } from "./types";

const attestationStore = (env: Env) => {
  if (!env.ATTESTATIONS) {
    return null;
  }
  return env.ATTESTATIONS.get(env.ATTESTATIONS.idFromName("github"));
};

const isVerification = (value: unknown): value is AttestationVerification =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { ok?: unknown }).ok === "boolean";

export const verifyArtifactAttestation = async (
  env: Env,
  input: VerifyArtifactInput,
): Promise<AttestationVerification> => {
  const store = attestationStore(env);
  if (!store) {
    return { ok: false };
  }
  const result = await store.verifyArtifact(input);
  return isVerification(result) ? result : { ok: false };
};
