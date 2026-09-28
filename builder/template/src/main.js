import "./style.css";
import { getMe, joinRoom } from "./ragbot.js";
import { members } from "./presence.js";

const $ = (id) => document.getElementById(id);

const me = await getMe();
$("name").textContent = `, ${me.name}`;

const room = joinRoom("lobby", {
  onStatus(status) {
    $("status").textContent = status === "open" ? "Connected" : "Reconnecting…";
    $("cheer").disabled = status !== "open";
  },
  onState(state) {
    $("count").textContent = String(state?.cheers ?? 0);
  },
  onPeers(peers) {
    $("peers").replaceChildren(
      ...members(peers).map((member) => {
        const item = document.createElement("li");
        item.textContent = member.name;
        return item;
      }),
    );
  },
});

$("cheer").addEventListener("click", () =>
  room.setState((state) => ({ ...state, cheers: (state?.cheers ?? 0) + 1 })),
);
