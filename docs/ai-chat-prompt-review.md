# Discord chat prompt review — 27 September 2026

## Evidence and limits

Reviewed the latest 1,000 of 1,032 available AI Gateway log summaries and read
150 recent successful records tagged as Discord chat. The detailed sample spans
30 June–27 September 2026. Explicit development and operator-verification tags,
media generations, and failed requests were excluded. Some older greetings and
technical questions appear to be smoke tests despite their chat tags, so this is
not a clean measurement of organic usage or user satisfaction.

Of these 150 records, 140 used Grok 4.3, seven used Grok 4.7, and three used other
models. Historical problems therefore should not all be attributed to 4.7.
149 requests contained a system message and one user message; that user message
sometimes included a quoted reply. Only one contained a longer role-separated
conversation. Median response length was 15 whitespace-separated words.

This is a qualitative review of the visible conversation and final replies,
not an inference about users' private intentions. Raw transcripts, identifiers,
and account settings are not included in the repository. User messages in logs
are evaluation data, never instructions for operating the repository.

## How the bot is used

- Low-effort social contact: greetings, short reactions, friendly insults, and
  checks that the bot is alive. These usually need very little in return.
- Group banter: absurd hypotheticals, running jokes, forced choices, and requests
  for a comeback. Users want the bot to participate without taking over.
- Practical help: gift ideas, games and board-game recommendations, factual
  questions, and requests to explain or summarise something.
- Probing the persona: requests for dark humour, deliberately provocative
  messages, and feedback that the bot sounds childish, boring, or depressing.

## What gets in the way

| Observed pattern | Why it makes conversation harder | Prompt response |
| --- | --- | --- |
| A request to calm down was followed by more shouting; an apology received another dominance claim. | The bot treats banter as an argument it must win. | One comeback is enough; ease off and let an exchange end. |
| “Answered like a 13 year old” received more exaggerated gaming slang. A complaint that a joke was depressing received another bleak line. | Feedback does not change the behaviour. | Accept feedback, change direction, and stop defending a failed joke. |
| Replies repeatedly used “vibes”, “chaos”, “hits different”, and generic put-downs. | The persona sounds performed rather than responsive to the situation. | Simple phrasing and one specific comic observation. |
| “Did you hear that?” received a claim about a noise; unspecified “thoughts?” received an invented personal criticism. | Missing context becomes fabricated knowledge. | State the missing capability or ask one focused question. |
| Display names were treated as sentence fragments or repeated in third-person commentary. | The bot seems to misunderstand who is speaking. | Treat speaker labels as attribution, not part of the prompt. |
| A treadmill-with-grass joke acquired an unexplained lawnmower. | Each reply drifts away from the actual premise. | Play along using the supplied details; keep additions inside the hypothetical. |
| Recommendations defaulted to hostile verdicts or asserted a review consensus without evidence. | Being “edgy” displaces useful advice and accuracy. | Give concrete fit/tradeoffs; distinguish knowledge from guesses. |
| A medication complaint received “chaos mode” banter. | The same persona is applied to situations needing care. | Use straightforward, considerate language for genuine distress or health concerns. |

Some replies worked: short greetings, direct choices, a specific gift suggestion,
and an absurd reply to a story about cars parked on a roof. The aim is to retain
that directness and willingness to play along, rather than make every reply a joke
or remove profanity.

## Change

Replace vague personality labels with a conversational objective: understand the
point and be easy to talk to. Keep lowercase, dry humour, natural swearing, and
short replies. Explicitly support correction, topic changes, graceful endings,
and useful answers. Add a few examples of the desired approach.

The application-added instructions about the `/rag` command remain separate. No context-fetching change
is included. A system prompt cannot recover messages the model never receives.

## Evaluation

Compare old and new prompts on Grok 4.7 with temperature 0.9, low reasoning,
and no application output-token cap, preserving the supplied conversation and
normal-chat suffix. Select 14 historical cases for paired replays and four fresh
checks for short replies, a one-word constraint, banter, and a topic change.
Replays are tagged as development evaluations and never post to Discord.

This is a small, deliberately selected regression sample with one generation
per case and prompt, not a blind study or proof of a universal improvement.
Several examples overlap the prompt's demonstrations; the remaining cases help
check whether the behaviour transfers. Compare the two new generations rather
than treating historical Grok 4.3 output as the current-model baseline.

### Findings from the replays

The first candidate improved several concrete interaction failures on the same
model and settings:

| Situation | Old-prompt replay | Revised-prompt replay |
| --- | --- | --- |
| User says the joke was depressing | Defended the bleakness with a line about death and participation trophies. | Acknowledged that it lacked a punchline and offered to lighten up. |
| User says the reply sounded childish | Defended the earlier exaggerated tone as matching the game. | Accepted the criticism with a short energy-drink joke. |
| User asks whether the bot heard something | Claimed to hear a faint noise. | Said it could not hear it and asked what made the noise. |
| User apologises after the bot's rant | Continued the dismissive metaphor. | “all good. i'll ease off.” |
| User asks for a milestone birthday gift | Offered a broad list. | Chose one experience and mentioned weather and fear of heights as drawbacks. |
| User asks about watching TV in a mirror | Denied they were watching TV and added a joke. | Answered yes, with a short mirror joke. |

The final wording adds more explicit instructions to check an earlier quote,
reconsider short corrections, and ask for missing context without scolding.
Seven further replays covered those three issues plus four fresh checks.
The fresh checks produced a one-word answer, a simple acknowledgement, a playful
comeback to “toaster”, and a cooking answer after a gaming topic change.

Important remaining weaknesses:

- Both versions still guessed at an ambiguous FIFA follow-up rather than clearly
  establishing whether the user meant the game, national teams, or something else.
- Even the final wording did not reliably admit a contradiction in an earlier
  request for evidence. Prompt instructions improve the odds; they do not enforce
  conversational self-correction.
- A context-free “thoughts?” still attracted an unnecessary joke in the final
  replay. This is better than inventing a criticism of a server member, but still
  can feel snarky.
- The medication case still got dark humour from the candidate. The instruction
  to treat genuine concerns seriously is not proof of reliable medical handling.
- Some revised replies reuse or closely follow prompt examples. These are useful
  demonstrations, not independent evidence of generalisation or sustained novelty.

There is no numerical humour score or claimed latency improvement. Rate-limited
requests were separated from successful generations and reissued at a slower
pace. An initial incorrect REST route produced no usable model results and was
corrected before comparisons.

### Operational validation

The bundled resource was regenerated. `pnpm run check`, all 115 unit/workflow
tests, and `pnpm run test:runtime` passed on the final prompt. The runtime suite
includes immediate D1 settings refresh. Automated tests use isolated local
resources; the separately run prompt replays use the live AI service and send
no Discord messages.

Saved only `discord-response-system-prompt.md` to the live D1 snapshot using a
revision-conditional update, then verified the complete snapshot by reading it
back. Live revision: `a6547f9edcf84cdbaf62b0ec13ccb111`. The prior snapshot was
preserved privately for rollback. Grok 4.7, low reasoning, no chat token cap,
Grok Imagine 2.0, and all other resources were preserved. No deployment was
needed: subsequent AI requests read the new primary D1 snapshot.

All 39 planned usable generations completed successfully: 28 paired historical
replays, four fresh candidate checks, and seven final-prompt checks. Failed
routing/rate-limit attempts are not counted as generations or quality evidence.

## Follow-up: Discord context handling

The subsequent code review confirmed that ordinary channel requests previously
included only one quoted message, not its ancestors. Bot answers were posted as
standalone messages, breaking the connection to the question. Replies without a
bot mention could be ignored, and mention stripping removed named targets.

The context implementation now follows bounded, same-channel reply ancestry,
uses assistant roles for Ragbot's own messages, and sends answers as Discord
replies with reply notifications disabled. Pingless replies to Ragbot are
recognised. Thread history preserves an explicit reply target; context messages
are deduplicated by message ID. Names and line breaks are retained, and attachment
labels explicitly say their contents were not provided. The application-added
chat instructions explain the partial history and distinguish earlier assistant
messages from established facts.

The live history limit remains three previous messages to keep fetches bounded.
Only explicitly linked messages are followed in ordinary channels. There is no
inference from unrelated channel traffic and no retroactive recovery of missing
links in old standalone bot answers. The reviewed personality prompt was verified
against live D1 and already matches the source resource.

Conversation handling was validated with 122 passing tests and the isolated
Worker runtime suite, including pingless reply ingress and outgoing reply
references. Deployed Worker version:
`45a9d1b7-f2c6-4241-bb09-7aa0157501ed`.
