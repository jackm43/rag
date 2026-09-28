import { DurableObject } from "cloudflare:workers";
import { type Env, json, boundedJSON } from "./types";
const words = [
  "apple",
  "beach",
  "brain",
  "bread",
  "chair",
  "charm",
  "chess",
  "cloud",
  "crane",
  "dance",
  "dream",
  "earth",
  "field",
  "flame",
  "fresh",
  "ghost",
  "grape",
  "green",
  "heart",
  "horse",
  "house",
  "lemon",
  "light",
  "magic",
  "metal",
  "might",
  "night",
  "ocean",
  "paint",
  "party",
  "peach",
  "piano",
  "plant",
  "point",
  "power",
  "pride",
  "quiet",
  "river",
  "robot",
  "round",
  "scale",
  "shark",
  "sheep",
  "shine",
  "smile",
  "snake",
  "space",
  "spice",
  "spoon",
  "sport",
  "stage",
  "steam",
  "stone",
  "storm",
  "sugar",
  "sweet",
  "table",
  "tiger",
  "toast",
  "tower",
  "train",
  "trust",
  "water",
  "whale",
  "wheel",
  "white",
  "world",
  "young",
];
type Game = {
  answer: string;
  version: number;
  guesses: { word: string; marks: string[]; player: string }[];
};
export function score(answer: string, guess: string) {
  const result = Array(5).fill("absent"),
    left = answer.split("");
  for (let i = 0; i < 5; i++)
    if (guess[i] === answer[i]) {
      result[i] = "correct";
      left[i] = "";
    }
  for (let i = 0; i < 5; i++)
    if (result[i] !== "correct") {
      const n = left.indexOf(guess[i]);
      if (n >= 0) {
        result[i] = "present";
        left[n] = "";
      }
    }
  return result;
}
function publicGame(g: Game) {
  const won = g.guesses.some((v) => v.word === g.answer),
    over = won || g.guesses.length >= 6;
  return {
    version: g.version,
    guesses: g.guesses,
    won,
    over,
    ...(over ? { answer: g.answer } : {}),
  };
}
export class Room extends DurableObject<Env> {
  async fetch(r: Request) {
    const p = new URL(r.url).pathname;
    if (p === "/destroy" && r.method === "DELETE") {
      await this.ctx.storage.deleteAll();
      return json({});
    }
    const data =
      r.method === "POST" || r.method === "PUT"
        ? await boundedJSON(r, 32000)
        : null;
    return this.ctx.storage.transaction(async (tx) => {
      if (p === "/wordle") {
        let g = await tx.get<Game>("game");
        if (!g) {
          g = {
            answer:
              words[
                crypto.getRandomValues(new Uint32Array(1))[0] % words.length
              ],
            version: 0,
            guesses: [],
          };
          await tx.put("game", g);
        }
        if (r.method === "GET") return json(publicGame(g));
        if (r.method !== "POST") return json({}, 405);
        if (data.version !== g.version) return json(publicGame(g), 409);
        if (data.reset === true) {
          if (!publicGame(g).over) return json({}, 409);
          g = {
            answer:
              words[
                crypto.getRandomValues(new Uint32Array(1))[0] % words.length
              ],
            version: g.version + 1,
            guesses: [],
          };
        } else {
          const guess = String(data.guess || "").toLowerCase();
          if (!/^[a-z]{5}$/.test(guess) || publicGame(g).over)
            return json({}, 400);
          g.guesses.push({
            word: guess,
            marks: score(g.answer, guess),
            player: r.headers.get("x-player") || "player",
          });
          g.version++;
        }
        await tx.put("game", g);
        return json(publicGame(g));
      }
      const state = (await tx.get<any>("state")) || { version: 0, data: {} };
      if (r.method === "GET") return json(state);
      if (r.method !== "PUT") return json({}, 405);
      if (data.version !== state.version) return json(state, 409);
      const next = { version: state.version + 1, data: data.data };
      await tx.put("state", next);
      return json(next);
    });
  }
}
