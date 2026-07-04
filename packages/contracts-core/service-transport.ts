import * as capnp from "capnp-es";
import { asFramedBytes } from "./framing";
import { ManifestSnapshot, ServiceManifest, ServiceMessage } from "./service";

// Encode/decode for the service-boundary transport types (service.capnp):
// the queue hop body and the registry RPC payloads. Decoders are total —
// malformed bytes yield null, never a throw — and only establish the WIRE
// shape; semantic validation (known principals, zones) belongs to the
// consumer (packages/service-kit).

export type WireServiceMessage = {
  envelope: Uint8Array;
  idToken: string;
};

export type WireServiceManifest = {
  service: string;
  zone: string;
  targets: string[];
  operations: string[];
  scopes: string[];
};

const textListToArray = (list: capnp.List<string>): string[] =>
  Array.from({ length: list.length }, (_, index) => list.get(index));

const setTextList = (init: (length: number) => capnp.List<string>, values: string[]) => {
  const list = init(values.length);
  values.forEach((value, index) => list.set(index, value));
};

export const encodeServiceMessage = (envelope: Uint8Array, idToken: string): Uint8Array => {
  const message = new capnp.Message();
  const root = message.initRoot(ServiceMessage);
  root._initEnvelope(envelope.byteLength).copyBuffer(envelope);
  root.idToken = idToken;
  return new Uint8Array(message.toArrayBuffer());
};

// A valid service message must carry a non-empty token and an inner envelope
// that is itself a sanely framed capnp message.
export const decodeServiceMessage = (value: unknown): WireServiceMessage | null => {
  const bytes = asFramedBytes(value);
  if (!bytes) {
    return null;
  }
  try {
    const root = new capnp.Message(bytes, false).getRoot(ServiceMessage);
    if (!root._hasEnvelope() || root.idToken.length === 0) {
      return null;
    }
    const envelope = new Uint8Array(root.envelope.toUint8Array());
    if (!asFramedBytes(envelope)) {
      return null;
    }
    return { envelope, idToken: root.idToken };
  } catch {
    return null;
  }
};

const writeManifest = (target: ServiceManifest, manifest: WireServiceManifest) => {
  target.service = manifest.service;
  target.zone = manifest.zone;
  setTextList((length) => target._initTargets(length), manifest.targets);
  setTextList((length) => target._initOperations(length), manifest.operations);
  setTextList((length) => target._initScopes(length), manifest.scopes);
};

const readManifest = (source: ServiceManifest): WireServiceManifest => ({
  service: source.service,
  zone: source.zone,
  targets: textListToArray(source.targets),
  operations: textListToArray(source.operations),
  scopes: textListToArray(source.scopes),
});

export const encodeServiceManifest = (manifest: WireServiceManifest): Uint8Array => {
  const message = new capnp.Message();
  writeManifest(message.initRoot(ServiceManifest), manifest);
  return new Uint8Array(message.toArrayBuffer());
};

export const decodeServiceManifest = (value: unknown): WireServiceManifest | null => {
  const bytes = asFramedBytes(value);
  if (!bytes) {
    return null;
  }
  try {
    const manifest = readManifest(new capnp.Message(bytes, false).getRoot(ServiceManifest));
    return manifest.service.length > 0 && manifest.zone.length > 0 ? manifest : null;
  } catch {
    return null;
  }
};

export const encodeManifestSnapshot = (manifests: WireServiceManifest[]): Uint8Array => {
  const message = new capnp.Message();
  const list = message.initRoot(ManifestSnapshot)._initManifests(manifests.length);
  manifests.forEach((manifest, index) => writeManifest(list.get(index), manifest));
  return new Uint8Array(message.toArrayBuffer());
};

export const decodeManifestSnapshot = (value: unknown): WireServiceManifest[] | null => {
  const bytes = asFramedBytes(value);
  if (!bytes) {
    return null;
  }
  try {
    const root = new capnp.Message(bytes, false).getRoot(ManifestSnapshot);
    const manifests: WireServiceManifest[] = [];
    const list = root.manifests;
    for (let index = 0; index < list.length; index += 1) {
      manifests.push(readManifest(list.get(index)));
    }
    return manifests;
  } catch {
    return null;
  }
};
