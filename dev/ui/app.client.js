// Local console: simulate real handlers, inspect every captured side effect.
(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "ragbot-dev-console-simple";
  const identityFields = ["userId", "username", "globalName", "nick"];
  const idFields = ["botUserId", "guildId", "channelId"];
  const overrideFields = ["model", "webSearchModel", "temperature", "maxTokens", "historyLimit"];
  const fields = [...identityFields, ...idFields, ...overrideFields, "mode", "mentionBot", "replyLast"];
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { saved = {}; }
  const state = saved && typeof saved === "object" ? saved : {};
  state.transcripts ??= {};
  let meta;
  let busy = false;
  const snowflake = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) | BigInt(Math.floor(Math.random() * 4096))).toString();
  const value = (id) => $(id).value.trim();
  const identity = () => Object.fromEntries(identityFields.map((id) => [id, value(id)]));
  const transcript = () => state.transcripts[value("channelId")] ??= [];
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const save = () => {
    for (const id of fields) state[id] = $(id).type === "checkbox" ? $(id).checked : $(id).value;
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Storage is optional. */ }
  };
  const status = (text, error = false) => {
    $("status").textContent = text;
    $("status").classList.toggle("error", error);
  };
  const json = (id, data) => { $(id).textContent = JSON.stringify(data ?? null, null, 2); };
  const api = async (path, body) => {
    const response = await fetch(`/api/${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  const overrides = () => Object.fromEntries(overrideFields.flatMap((id) => {
    const input = value(id);
    return input ? [[id, $(id).type === "number" ? Number(input) : input]] : [];
  }));
  const renderTranscript = () => {
    const entries = transcript();
    $("transcript").replaceChildren(...entries.map((entry) => {
      const card = node("div", "", `message ${entry.role}`);
      const author = entry.author ?? {};
      card.append(node("strong", entry.role === "bot" ? "ragbot" : author.nick || author.globalName || author.username || "user"), node("div", entry.content));
      return card;
    }));
    if (!entries.length) $("transcript").append(node("p", "This channel has no conversation yet. Thread modes use this transcript as history."));
    $("transcript").scrollTop = $("transcript").scrollHeight;
  };
  const renderResult = (result) => {
    json("payload", result.message ?? result.interaction);
    json("requests", result.ai.map(({ model, request }) => ({ model, request })));
    json("responses", result.ai.map(({ model, response, error, durationMs }) => ({ model, response, error, durationMs })));
    for (const id of ["calls", "logs", "db"]) json(id, result[id]);
    $("replies").replaceChildren();
    for (const key of ["replies", "edits", "followUps", "channelMessages"]) {
      for (const reply of result[key] ?? []) {
        $("replies").append(node("strong", `${key} → ${reply.channelId}`), node("p", reply.content));
        for (const file of reply.attachments ?? []) {
          $("replies").append(node("p", `${file.name} · ${file.contentType} · ${file.bytes} bytes`));
          const tag = file.dataUrl?.startsWith("data:image/") ? "img" : file.dataUrl?.startsWith("data:audio/") ? "audio" : null;
          if (!tag) continue;
          const media = document.createElement(tag);
          media.src = file.dataUrl;
          if (tag === "img") media.alt = file.name;
          else media.controls = true;
          $("replies").append(media);
        }
      }
    }
    for (const thread of result.threadsCreated ?? []) $("replies").append(node("p", `Created thread ${thread.name} (${thread.id})`));
    for (const exchange of result.ai.filter((item) => item.error)) $("replies").append(node("p", `Model failed: ${exchange.error}. Inspect AI responses below.`));
    if (!$("replies").childElementCount) $("replies").append(node("p", "No reply was sent. Inspect worker logs and database effects below."));
  };
  const run = async (task) => {
    if (busy) return;
    busy = true;
    save();
    document.querySelectorAll(".controls input, .controls select, .controls textarea, .controls button").forEach((el) => { el.disabled = true; });
    status("Running…");
    try { await task(); } catch (error) { status(error.message, true); }
    finally {
      busy = false;
      document.querySelectorAll(".controls input, .controls select, .controls textarea, .controls button").forEach((el) => { el.disabled = false; });
      save();
    }
  };
  const simulationInput = () => {
    const user = identity();
    if (!/^\d{17,20}$/.test(user.userId) || !user.username) throw new Error("Set a valid user ID and username first.");
    if (!/^\d{17,20}$/.test(value("channelId"))) throw new Error("Set a valid channel ID first.");
    return { identity: user, guildId: value("guildId"), channelId: value("channelId"), overrides: overrides() };
  };
  const renderCommand = () => {
    const command = meta.commands.find((item) => item.name === $("command").value);
    $("command-description").textContent = `${command.description}${command.adminOnly ? " · admin only" : ""}${command.requiredRoleId ? " · Mods role required" : ""}`;
    $("command-options").replaceChildren();
    for (const option of command.options ?? []) {
      for (const field of option.type === 6 ? ["value", "username"] : ["value"]) {
        const label = node("label", `${option.name}${field === "username" ? " username (optional)" : option.required ? " *" : ""}`);
        const input = document.createElement((option.max_length ?? 0) > 200 ? "textarea" : "input");
        input.dataset.option = option.name;
        input.dataset.field = field;
        input.required = field === "value" && option.required;
        input.placeholder = option.type === 6 && field === "value" ? "User ID" : option.description;
        if (option.min_length) input.minLength = option.min_length;
        if (option.max_length) input.maxLength = option.max_length;
        label.append(input);
        $("command-options").append(label);
      }
    }
  };
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!value("content")) return;
    void run(async () => {
      const input = simulationInput();
      const content = $("content").value;
      const entries = transcript();
      const lastBot = entries.findLast((entry) => entry.role === "bot");
      const result = await api("mention", {
        ...input, content, botUserId: value("botUserId"), mode: value("mode"), mentionBot: $("mentionBot").checked,
        transcript: entries, replyToId: $("replyLast").checked ? lastBot?.id : undefined,
      });
      entries.push({ id: result.message.id, role: "user", content: result.message.content, author: input.identity });
      for (const reply of result.replies) entries.push({ id: reply.id ?? snowflake(), role: "bot", content: reply.content });
      $("content").value = "";
      renderTranscript();
      renderResult(result);
      status(`${result.replies.length ? "Reply received" : "No reply"} in ${result.durationMs} ms.`);
    });
  });
  $("slash-panel").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      const input = simulationInput();
      const command = meta.commands.find((item) => item.name === $("command").value);
      const values = {};
      for (const element of $("command-options").querySelectorAll("[data-option]")) {
        (values[element.dataset.option] ??= {})[element.dataset.field] = element.value;
      }
      const options = [], resolvedUsers = {};
      for (const option of command.options ?? []) {
        const entry = values[option.name];
        const text = entry?.value?.trim();
        if (!text) continue;
        options.push({ name: option.name, type: option.type, value: text });
        if (option.type === 6) resolvedUsers[text] = { userId: text, username: entry.username?.trim() || `user_${text.slice(-4)}` };
      }
      const result = await api("interaction", { ...input, command: command.name, options, resolvedUsers });
      renderResult(result);
      status(`Done in ${result.durationMs} ms.`);
    });
  });
  for (const button of document.querySelectorAll("[data-page]")) button.addEventListener("click", () => {
    for (const tab of document.querySelectorAll("[data-page]")) {
      const active = tab === button;
      tab.setAttribute("aria-pressed", String(active));
      $(`${tab.dataset.page}-panel`).hidden = !active;
    }
  });
  for (const id of fields) $(id).addEventListener("change", () => { save(); if (id === "channelId") renderTranscript(); });
  $("command").addEventListener("change", renderCommand);
  $("new-channel").addEventListener("click", () => { $("channelId").value = snowflake(); save(); renderTranscript(); });
  $("clear-transcript").addEventListener("click", () => { state.transcripts[value("channelId")] = []; save(); renderTranscript(); });
  $("show-config").addEventListener("click", () => run(async () => {
    json("config", await api("config", { overrides: overrides() }));
    $("config-panel").hidden = false;
    $("config-panel").open = true;
    status("Showing resolved configuration.");
  }));
  const boot = async () => {
    meta = await api("meta");
    for (const id of fields) {
      if (state[id] !== undefined) $(id)[$(id).type === "checkbox" ? "checked" : "value"] = state[id];
    }
    for (const [id, fallback] of [["botUserId", meta.applicationId], ["guildId", meta.guildId], ["channelId", snowflake()]]) {
      if (!/^\d{17,20}$/.test(value(id))) $(id).value = fallback;
    }
    for (const [id, key] of [["model", "responseModel"], ["webSearchModel", "askWebSearchModel"], ["temperature", "temperature"], ["maxTokens", "maxTokens"], ["historyLimit", "historyLimit"]]) $(id).placeholder = meta.config[key];
    $("command").replaceChildren(...meta.commands.map((command) => new Option(`/${command.name}`, command.name)));
    $("connection").textContent = meta.hasAigToken ? "AI connected · Discord stubbed" : "AI token missing";
    renderCommand();
    renderTranscript();
    save();
  };
  boot().catch((error) => { $("connection").textContent = "Connection failed"; status(error.message, true); });
})();
