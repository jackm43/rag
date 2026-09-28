// Collapse connections (tabs) into one entry per member, sorted by name.
export function members(peers) {
  const byId = new Map();
  for (const peer of peers)
    byId.set(peer.id, { ...peer, tabs: (byId.get(peer.id)?.tabs ?? 0) + 1 });
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
