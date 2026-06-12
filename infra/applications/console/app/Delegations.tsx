import { useEffect, useMemo, useState } from "react";
import type { Client } from "@connectrpc/connect";

import type { DiscoveryService } from "../../discovery/server/discovery/v1/discovery_pb";

import { DELEGATION_GRAPH_QUERY, queryDiscovery, type DelegationEdge } from "./discovery";

// Delegation graph view: a bipartite SVG rendering of the registry's
// delegation edges (acting application on the left, target audience on the
// right). Selecting an edge lists the scopes it grants.

const ROW_HEIGHT = 44;
const NODE_WIDTH = 180;
const NODE_HEIGHT = 30;
const SVG_WIDTH = 720;
const PAD_TOP = 12;

export function Delegations({
  signedIn,
  discovery,
}: {
  signedIn: boolean;
  discovery: Client<typeof DiscoveryService> | null;
}) {
  const [edges, setEdges] = useState<DelegationEdge[]>([]);
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    if (!discovery) {
      setNote("discovery application is not available");
      return;
    }
    setNote("loading");
    queryDiscovery<{ delegationGraph: DelegationEdge[] }>(discovery, DELEGATION_GRAPH_QUERY)
      .then((data) => {
        setEdges(data.delegationGraph ?? []);
        setNote("");
      })
      .catch((err) => setNote((err as Error).message));
  }, [signedIn, discovery]);

  const { actors, audiences } = useMemo(() => {
    const actorNames = [...new Set(edges.map((edge) => edge.application))].sort();
    const audienceNames = [...new Set(edges.map((edge) => edge.audience))].sort();
    return { actors: actorNames, audiences: audienceNames };
  }, [edges]);

  const height = PAD_TOP * 2 + Math.max(actors.length, audiences.length, 1) * ROW_HEIGHT;
  const rightX = SVG_WIDTH - NODE_WIDTH;

  const nodeY = (index: number): number => PAD_TOP + index * ROW_HEIGHT;
  const edgeFor = selected !== null ? edges[selected] : null;

  return (
    <div className="view">
      <div className="view-head">
        <h1>Delegation graph</h1>
        <span className="hint">
          {edges.length} edge{edges.length === 1 ? "" : "s"}; click an edge for its scopes
        </span>
      </div>
      {note ? <div className="note">{note}</div> : null}

      <div className="panel graph-panel">
        <svg
          className="delegation-graph"
          viewBox={`0 0 ${SVG_WIDTH} ${height}`}
          preserveAspectRatio="xMidYMin meet"
        >
          {edges.map((edge, index) => {
            const fromIndex = actors.indexOf(edge.application);
            const toIndex = audiences.indexOf(edge.audience);
            const y1 = nodeY(fromIndex) + NODE_HEIGHT / 2;
            const y2 = nodeY(toIndex) + NODE_HEIGHT / 2;
            const x1 = NODE_WIDTH;
            const x2 = rightX;
            const mid = (x1 + x2) / 2;
            const isSelected = index === selected;
            return (
              <path
                key={`${edge.application}->${edge.audience}`}
                className={`graph-edge${isSelected ? " selected" : ""}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                onClick={() => setSelected(isSelected ? null : index)}
              />
            );
          })}
          {actors.map((name, index) => (
            <g key={`actor-${name}`}>
              <rect
                className="graph-node actor"
                x={0}
                y={nodeY(index)}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={6}
              />
              <text className="graph-label" x={10} y={nodeY(index) + NODE_HEIGHT / 2 + 4}>
                {name}
              </text>
            </g>
          ))}
          {audiences.map((name, index) => (
            <g key={`audience-${name}`}>
              <rect
                className="graph-node audience"
                x={rightX}
                y={nodeY(index)}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={6}
              />
              <text className="graph-label" x={rightX + 10} y={nodeY(index) + NODE_HEIGHT / 2 + 4}>
                {name}
              </text>
            </g>
          ))}
        </svg>

        <div className="graph-side">
          <h2>Edge scopes</h2>
          {edgeFor ? (
            <>
              <p className="mono strong">
                {edgeFor.application} acts into {edgeFor.audience}
              </p>
              {edgeFor.scopes.length > 0 ? (
                <ul>
                  {edgeFor.scopes.map((scope) => (
                    <li key={scope} className="scope">
                      {scope}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">all scopes of the audience</p>
              )}
            </>
          ) : (
            <p className="hint">select an edge in the graph</p>
          )}

          <h2>All edges</h2>
          <ul className="edge-list">
            {edges.map((edge, index) => (
              <li key={`${edge.application}->${edge.audience}`}>
                <button
                  className={`edge-row${index === selected ? " active" : ""}`}
                  onClick={() => setSelected(index === selected ? null : index)}
                >
                  <span className="mono">{edge.application}</span>
                  <span className="hint">to</span>
                  <span className="mono">{edge.audience}</span>
                  <span className="hint">
                    {edge.scopes.length > 0 ? `${edge.scopes.length} scope${edge.scopes.length === 1 ? "" : "s"}` : "all"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
