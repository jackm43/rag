import type { EntityJson, EntityUidJson } from "@cedar-policy/cedar-wasm/web";

// Authorization data: rag-admins group membership. This file (not code) is
// what changes when an admin is added or removed.
export const RAG_ADMIN_USER_IDS = [
  "107426926909517824",
  "116163000339136518",
  "102637456385392640",
  "114128631474683907",
];

const RAG_ADMINS_GROUP: EntityUidJson = { type: "Group", id: "rag-admins" };

// Static entity store handed to every authorization call: the admin group and
// its members. Principals absent from the store simply belong to no group.
// Dynamic entities (the service-registry snapshot) are merged in by callers.
export const staticEntities: EntityJson[] = [
  { uid: RAG_ADMINS_GROUP, attrs: {}, parents: [] },
  ...RAG_ADMIN_USER_IDS.map((id) => ({
    uid: { type: "Human", id },
    attrs: {},
    parents: [RAG_ADMINS_GROUP],
  })),
];
