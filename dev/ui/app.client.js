// Local console: simulate real handlers, inspect every captured side effect.
(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "ragbot-dev-console-simple";
  const identityFields = ["userId", "username", "globalName", "nick"];
  const idFields = ["botUserId", "guildId", "channelId"];
  const overrideFields = ["model", "webSearchModel", "webSearchMaxTokens", "webSearchContextSize", "temperature", "maxTokens", "historyLimit", "systemPrompt", "webSearchSystemPrompt", "imageProfile", "imageModel", "imageAspectRatio", "imageQuality", "imageResolution"];
  const fields = [...identityFields, ...idFields, "modsRole", "mode", "mentionBot", "replyLast"];
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { saved = {}; }
  const state = saved && typeof saved === "object" ? saved : {};
  state.transcripts ??= {};
  state.pages ??= {};
  let page = "chat";
  const results = {};
  let meta;
  let catalog = { chat: [], search: [], image: [] };
  let busy = false;
  let baseline;
  let review;
  const invalidateReview = () => { review = undefined; $("settings-review").hidden = true; };
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
    const draft = state.pages[page] ??= {};
    for (const id of overrideFields) draft[id] = $(id).value;
    draft.content = $("content").value;
    draft.options = Object.fromEntries([...$("command-options").querySelectorAll("[data-option]")].map(el => [`${el.dataset.option}:${el.dataset.field}`, el.value]));
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Storage is optional. */ }
  };
  const status = (text, error = false) => {
    $("status").textContent = text;
    $("status").classList.toggle("error", error);
  };
  const json = (id, data) => { $(id).textContent = JSON.stringify(data ?? null, null, 2); };
  const api = async (path, body) => {
    const response = await fetch(`/api/${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", "x-ragbot-ui": "1" }, body: JSON.stringify(body),
    });
    if (!(response.headers.get("content-type") || "").includes("application/json")) throw new Error("The local worker is restarting or unavailable. Try again.");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  const overrides = () => Object.fromEntries(overrideFields.flatMap((id) => {
    const isImage = id.startsWith("image");
    if ((page === "bicture") !== isImage) return [];
    if (!["chat", "ask", "bicture"].includes(page)) return [];
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
    results[page] = result;
    const revisions = [...new Set(result.ai.map(item => item.settingsRevision).filter(Boolean))];
    $("settings-used").textContent = revisions.length ? `Settings used: ${revisions.join(", ")}` : "No model request was made.";
    json("payload", result.message ?? result.interaction);
    json("requests", result.ai.map(({ model, request, settingsRevision }) => ({ model, request, settingsRevision })));
    json("responses", result.ai.map(({ model, response, error, durationMs }) => ({ model, response, error, durationMs })));
    for (const id of ["calls", "logs", "db"]) json(id, result[id]);
    $("replies").replaceChildren();
    for (const key of (result.replies ? ["replies"] : ["edits", "followUps", "channelMessages"])) {
      for (const reply of result[key] ?? []) {
        $("replies").append(node("strong", "ragbot"), node("p", reply.content));
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
    for (const id of overrideFields) {
      if (!$(id).closest("[hidden]") && !$(id).reportValidity()) return;
    }
    busy = true;
    save();
    document.querySelectorAll(".controls input, .controls select, .controls textarea, .controls button").forEach((el) => { el.disabled = true; });
    status("Running…");
    try { await task(); } catch (error) { status(error.message, true); }
    finally {
      busy = false;
      document.querySelectorAll(".controls input, .controls select, .controls textarea, .controls button").forEach((el) => { el.disabled = false; });
      updateSettings();
      save();
    }
  };
  const simulationInput = () => {
    const user = identity();
    if (!/^\d{17,20}$/.test(user.userId) || !user.username) throw new Error("Set a valid user ID and username first.");
    if (!/^\d{17,20}$/.test(value("channelId"))) throw new Error("Set a valid channel ID first.");
    return { target: baseline?.target ?? "local", baseRevision: baseline?.revision, identity: user, modsRole: $("modsRole").checked, guildId: value("guildId"), channelId: value("channelId"), overrides: overrides() };
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
        input.value = state.pages[page]?.options?.[`${option.name}:${field}`] ?? (option.type === 6 ? (field === "value" ? "123456789012345679" : "sample_user") : "");
        input.addEventListener("input", save);
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
      status(result.ai.some(item => item.error) ? "Model request failed. See the output for details." : `${result.replies.length ? "Reply received" : "No reply"} in ${result.durationMs} ms.`, result.ai.some(item => item.error));
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
      status(result.ai.some(item => item.error) ? "Model request failed. See the output for details." : `Done in ${result.durationMs} ms.`, result.ai.some(item => item.error));
    });
  });
  const updateSettings = () => {
    if (!meta) return;
    const config = meta.config;
    for (const [id, key] of [["model", "responseModel"], ["webSearchModel", "askWebSearchModel"], ["temperature", "temperature"], ["maxTokens", "maxTokens"], ["historyLimit", "historyLimit"], ["webSearchMaxTokens", "askWebSearchMaxOutputTokens"], ["webSearchContextSize", "askWebSearchContextSize"]]) {
      if ($(id).tagName === "INPUT") $(id).placeholder = config[key];
      $(`${id}-current`).textContent = `Current: ${value(id) || config[key]} · Default: ${config[key]}`;
    }
    for (const id of ["systemPrompt", "webSearchSystemPrompt"]) $(`${id}-current`).textContent = value(id) ? "Current: your custom prompt" : "Current: saved prompt (shown below)";
    const image = config.image;
    const profileName = value("imageProfile") || image.activeProfile;
    const profile = image.profiles[profileName];
    $("imageProfile-current").textContent = `Current: ${profileName} · Default: ${image.activeProfile}`;
    const selectedImage = value("imageModel") || profile.model;
    const imageModel = catalog.image.find(m => m.id === selectedImage);
    $("imageModel-current").textContent = `Current: ${selectedImage} · Profile: ${profile.model}`;
    for (const [id, field, key] of [["imageAspectRatio", "aspect_ratio", "aspectRatio"], ["imageQuality", "quality", "quality"], ["imageResolution", "resolution", "resolution"]]) {
      const spec = imageModel?.parameters?.[field];
      const previous = value(id);
      const fallback = spec ? ((!spec.enum || spec.enum.includes(profile[key])) ? profile[key] : spec.default) : undefined;
      $(id).replaceChildren(new Option(spec ? `Default (${fallback || "model default"})` : "Not supported by this model", ""), ...(spec?.enum ?? []).map(option => new Option(option, option)));
      if (spec?.enum?.includes(previous)) $(id).value = previous;
      $(id).disabled = busy || !spec;
      $(`${id}-current`).textContent = spec ? `Current: ${value(id) || fallback || "model default"} · Available: ${(spec.enum ?? []).join(", ") || "model default"}` : "This parameter is not sent to this model.";
    }
    const canChat = catalog.chat.some(m => m.id === (value("model") || config.responseModel));
    const canImage = Boolean(imageModel);
    $("review-settings").disabled = busy || !baseline;
    $("send").disabled = busy || !baseline || !canChat;
    $("run-command").disabled = busy || !baseline || (page === "bicture" && !canImage) || (page === "ask" && !canChat);
    $("default-prompt").textContent = config.systemPrompt;
    $("default-search-prompt").textContent = config.askWebSearchSystemPrompt;
  };
  const showPage = () => {
    if (!meta || busy) return;
    invalidateReview();
    save();
    const requested = location.hash.slice(1).replace(/^\//, "");
    page = meta.commands.some(c => c.name === requested) ? requested : "chat";
    const chat = page === "chat", image = page === "bicture";
    $("mention-panel").hidden = !chat;
    $("slash-panel").hidden = chat;
    $("model-panel").hidden = !["chat", "ask", "bicture"].includes(page);
    $("chat-settings").hidden = image;
    $("search-settings").hidden = image;
    $("image-settings").hidden = !image;
    $("page-title").textContent = chat ? "Chat playground" : `/${page}`;
    $("page-description").textContent = chat ? "Adjust the system prompt, send messages, and inspect the conversation." : image ? "Choose an image profile, describe your image, and see the result." : meta.commands.find(c => c.name === page).description;
    $("result-title").textContent = image ? "Generated image" : "Output";
    document.title = `${chat ? "Chat" : "/" + page} · ragbot dev studio`;
    for (const link of $("pages").children) {
      if (link.dataset.page === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    const draft = state.pages[page] ?? {};
    for (const id of overrideFields) {
      if (["model", "webSearchModel", "imageModel"].includes(id) && draft[id] && ![...$(id).options].some(o => o.value === draft[id])) {
        $(id).value = "";
        $("catalog-status").textContent = "A saved model is no longer eligible for Cloudflare credits. Choose an available model.";
      } else $(id).value = draft[id] ?? "";
    }
    updateSettings();
    for (const id of ["imageAspectRatio", "imageQuality", "imageResolution"]) {
      if ([...$(id).options].some(o => o.value === draft[id])) $(id).value = draft[id];
    }
    $("content").value = draft.content ?? "";
    $("command-options").replaceChildren();
    if (!chat) {
      $("command").value = page;
      renderCommand();
      $("run-command").textContent = image ? "Generate image" : `Run /${page}`;
    }
    $("config-panel").hidden = true;
    if (results[page]) renderResult(results[page]);
    else {
      $("settings-used").textContent = "";
      $("replies").replaceChildren(node("p", image ? "Your generated image will appear here." : "Send a prompt or run this command to see the output."));
      for (const id of ["payload", "requests", "responses", "calls", "logs", "db"]) $(id).textContent = "—";
    }
    updateSettings();
    status("Ready. Identity and channel are filled in.");
  };
  window.addEventListener("hashchange", showPage);
  $("pages").addEventListener("click", event => { if (busy) event.preventDefault(); });
  for (const id of overrideFields) $(id).addEventListener("input", () => {
    invalidateReview();
    if (["imageModel", "imageProfile"].includes(id)) {
      for (const setting of ["imageAspectRatio", "imageQuality", "imageResolution"]) $(setting).value = "";
    }
    updateSettings(); save();
  });
  $("content").addEventListener("input", save);
  $("reset-settings").addEventListener("click", () => { invalidateReview(); for (const id of overrideFields) $(id).value = ""; save(); updateSettings(); });
  for (const [button, field, key] of [["edit-prompt", "systemPrompt", "systemPrompt"], ["edit-search-prompt", "webSearchSystemPrompt", "askWebSearchSystemPrompt"]]) {
    $(button).addEventListener("click", () => { $(field).value = meta.config[key]; invalidateReview(); updateSettings(); save(); $(field).focus(); });
  }
  const resetIdentity = () => {
    for (const [id, setting] of Object.entries(meta.defaults)) $(id).value = setting;
    $("nick").value = "";
    $("botUserId").value = meta.applicationId;
    $("guildId").value = meta.guildId;
    $("modsRole").checked = true;
  };
  $("reset-identity").addEventListener("click", () => { resetIdentity(); save(); renderTranscript(); });
  for (const id of fields) $(id).addEventListener("change", () => { save(); if (id === "channelId") renderTranscript(); });
  $("command").addEventListener("change", renderCommand);
  $("new-channel").addEventListener("click", () => { $("channelId").value = snowflake(); save(); renderTranscript(); });
  $("clear-transcript").addEventListener("click", () => { state.transcripts[value("channelId")] = []; save(); renderTranscript(); });
  $("show-config").addEventListener("click", () => run(async () => {
    json("config", await api("config", { target: baseline?.target ?? "local", baseRevision: baseline?.revision, overrides: overrides(), page }));
    $("config-panel").hidden = false;
    $("config-panel").open = true;
    status("Showing resolved configuration.");
  }));
  const loadModels = async (refresh = false) => {
    $("catalog-status").textContent = "Checking Cloudflare-credit model availability…";
    try {
      catalog = await api("models", { target: baseline?.target ?? "local", refresh });
      $("catalog-status").textContent = `${catalog.chat.length} compatible chat models · ${catalog.image.length} image models · checked ${new Date(catalog.checkedAt * 1000).toLocaleTimeString()}.`;
    } catch (error) {
      catalog = { chat: [], search: [], image: [] };
      $("catalog-status").textContent = error.message;
    }
    const table = document.createElement("table");
    table.append(node("caption", "Configured profiles using Cloudflare credits"));
    for (const [name, profile] of Object.entries(meta.config.image.profiles).filter(([, p]) => catalog.image.some(m => m.id === p.model))) {
      const row = document.createElement("tr");
      row.append(node("th", name), node("td", `${profile.model} · ${profile.resolution} · ${profile.aspectRatio} · quality: ${profile.quality}`));
      table.append(row);
    }
    $("profile-options").replaceChildren(table);
    const previousProfile = value("imageProfile");
    $("imageProfile").replaceChildren(new Option(`Default (${meta.config.image.activeProfile})`, ""), ...Object.entries(meta.config.image.profiles).filter(([, p]) => catalog.image.some(m => m.id === p.model)).map(([name]) => new Option(name, name)));
    $("imageProfile").options[0].disabled = !catalog.image.some(m => m.id === meta.config.image.profiles[meta.config.image.activeProfile].model);
    if ([...$("imageProfile").options].some(o => o.value === previousProfile)) $("imageProfile").value = previousProfile;
    for (const [id, group, fallback] of [["model", "chat", meta.config.responseModel], ["webSearchModel", "search", meta.config.askWebSearchModel], ["imageModel", "image", meta.config.image.profiles[meta.config.image.activeProfile].model]]) {
      const previous = value(id);
      const eligibleDefault = catalog[group].some(m => m.id === fallback);
      const defaultOption = new Option(eligibleDefault ? (id === "imageModel" ? "Use profile model" : `Default (${fallback})`) : "Choose a Cloudflare-credit model", "");
      defaultOption.disabled = !eligibleDefault;
      $(id).replaceChildren(defaultOption, ...catalog[group].map(m => new Option(`${m.name} — ${m.id}`, m.id)));
      $(id).selectedIndex = 0;
      if (catalog[group].some(m => m.id === previous)) $(id).value = previous;
    }
  };
  $("refresh-models").addEventListener("click", () => run(async () => {
    await loadModels(true); updateSettings(); status("Model availability refreshed.");
  }));
  const loadSettings = async () => {
    invalidateReview();
    baseline = undefined;
    $("settings-status").textContent = "Loading saved settings…";
    try {
      baseline = await api("settings/load", { target: value("settings-target") });
      meta.config = baseline.config;
      $("settings-status").textContent = `Loaded ${baseline.label} · ${baseline.source === "d1" ? "D1" : "legacy defaults"} · revision ${baseline.revision}${baseline.updatedAt ? " · saved " + new Date(baseline.updatedAt).toLocaleString() : " · existing defaults"}. Changes below are drafts until saved.`;
      await loadModels();
      updateSettings();
    } catch (error) {
      $("settings-status").textContent = error.message;
      throw error;
    }
  };
  $("settings-target").addEventListener("change", () => run(async () => {
    await loadSettings();
    status("Saved settings loaded. Your draft changes are still available for testing and review.");
  }));
  $("load-settings").addEventListener("click", () => run(async () => { await loadSettings(); status("Saved settings reloaded."); }));
  $("review-settings").addEventListener("click", () => run(async () => {
    invalidateReview();
    if (!baseline) throw new Error("Load settings before reviewing changes.");
    const draft = { target: baseline.target, baseRevision: baseline.revision, overrides: overrides(), page };
    const result = await api("settings/review", draft);
    review = { ...draft, reviewId: result.reviewId };
    $("review-title").textContent = `Changes for ${result.label}`;
    $("settings-changes").replaceChildren(...result.changes.map(change => {
      const item = node("details", ""); item.open = true;
      item.append(node("summary", change.resource), node("strong", "Saved"), node("pre", change.before), node("strong", "After save"), node("pre", change.after));
      return item;
    }));
    $("save-settings").textContent = baseline.target === "live" ? "Save to live bot" : "Save to local sandbox";
    $("save-settings").hidden = !result.changes.length;
    if (!result.changes.length) $("settings-changes").append(node("p", "No changes to save."));
    $("settings-review").hidden = false;
    status("Review the changes before saving.");
  }));
  $("save-settings").addEventListener("click", () => run(async () => {
    if (!review) throw new Error("Review changes before saving.");
    baseline = await api("settings/save", review);
    meta.config = baseline.config;
    invalidateReview();
    for (const id of overrideFields) $(id).value = "";
    save();
    await loadModels();
    $("settings-status").textContent = `Saved to ${baseline.label} at ${new Date(baseline.updatedAt).toLocaleTimeString()}. Revision ${baseline.revision}. New AI requests use these settings immediately.`;
    status("Settings saved. No redeploy needed for future setting changes.");
  }));
  const boot = async () => {
    meta = await api("meta");
    await loadSettings();
    resetIdentity();
    for (const id of fields) {
      if (state[id] !== undefined) $(id)[$(id).type === "checkbox" ? "checked" : "value"] = state[id];
    }
    for (const [id, fallback] of [["botUserId", meta.applicationId], ["guildId", meta.guildId], ["channelId", snowflake()]]) {
      if (!/^\d{17,20}$/.test(value(id))) $(id).value = fallback;
    }
    if (!/^\d{17,20}$/.test(value("userId"))) $("userId").value = meta.defaults.userId;
    if (!value("username")) $("username").value = meta.defaults.username;
    $("command").replaceChildren(...meta.commands.map((command) => new Option(`/${command.name}`, command.name)));
    $("pages").replaceChildren(...[{name: "chat"}, ...meta.commands].map(command => {
      const link = node("a", command.name === "chat" ? "Chat" : `/${command.name}`);
      link.href = `#/${command.name}`;
      link.dataset.page = command.name;
      return link;
    }));

    // Preserve pre-existing chat overrides when upgrading the old console.
    state.pages.chat ??= Object.fromEntries(overrideFields.map(id => [id, state[id] ?? ""]));
    for (const id of overrideFields) $(id).value = state.pages.chat[id] ?? "";
    $("content").value = state.pages.chat.content ?? "";
    $("connection").textContent = meta.hasAigToken ? "AI connected · Discord stubbed" : "AI token missing";
    showPage();
    renderTranscript();
    save();
    setInterval(async () => {
      if (busy) return;
      try {
        const { revision } = await api("revision");
        if (revision !== meta.revision && !busy) { save(); location.reload(); }
      } catch { /* Worker rebuilds briefly interrupt requests. */ }
    }, 2000);
  };
  boot().catch((error) => { $("connection").textContent = "Connection failed"; status(error.message, true); });
})();
