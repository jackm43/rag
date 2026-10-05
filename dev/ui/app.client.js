// Local console: simulate real handlers, inspect every captured side effect.
(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "ragbot-dev-console-simple";
  const identityFields = ["userId", "username", "globalName", "nick"];
  const idFields = ["botUserId", "guildId", "channelId"];
  const overrideFields = ["model", "temperature", "historyLimit", "systemPrompt", "imageProfile", "imageModel", "imageAspectRatio", "imageQuality", "imageResolution"];
  const imageParameterFields = [["imageAspectRatio", "aspect_ratio"], ["imageQuality", "quality"], ["imageResolution", "resolution"]];
  const fields = [...identityFields, ...idFields, "modsRole", "mentionBot", "replyLast"];
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { saved = {}; }
  const state = saved && typeof saved === "object" ? saved : {};
  state.transcripts ??= {};
  state.pages ??= {};
  let page = "chat";
  const results = {};
  let meta;
  let catalog = { chat: [], image: [] };
  let busy = false;
  let baseline;
  let review;
  let historyNext = null;
  const clearHistory = () => {
    historyNext = null;
    $("history-entries").replaceChildren();
    $("more-history").hidden = true;
    $("history-status").textContent = page === "bicture"
      ? "Fetch saved image prompts from /bicture."
      : "Fetch saved prompts from mentions and replies.";
  };
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
    if (!["chat", "bicture"].includes(page)) return [];
    if (id === "temperature" && !catalog.chat.find(m => m.id === (value("model") || meta?.settings.chat.model))?.temperature) return [];
    const input = value(id);
    return input ? [[id, $(id).type === "number" ? Number(input) : input]] : [];
  }));
  // The whole draft: saved settings with this page's form changes applied.
  const draftSettings = () => {
    const draft = structuredClone({ chat: meta.settings.chat, image: meta.settings.image });
    const changed = overrides();
    if (page === "chat") {
      if (changed.model) draft.chat.model = changed.model;
      if (changed.temperature !== undefined) draft.chat.temperature = changed.temperature;
      if (changed.historyLimit !== undefined) draft.chat.historyLimit = changed.historyLimit;
      if (changed.systemPrompt) draft.chat.prompt = changed.systemPrompt;
    } else if (page === "bicture") {
      draft.image.activeProfile = changed.imageProfile || draft.image.activeProfile;
      const profile = draft.image.profiles[draft.image.activeProfile];
      if (changed.imageModel) profile.model = changed.imageModel;
      for (const [id, field] of imageParameterFields) if (changed[id]) profile.parameters[field] = changed[id];
    }
    return draft;
  };
  const editsSettings = () => baseline && ["chat", "bicture"].includes(page);
  const renderTranscript = () => {
    const entries = transcript();
    $("transcript").replaceChildren(...entries.map((entry) => {
      const card = node("div", "", `message ${entry.role}`);
      const author = entry.author ?? {};
      card.append(node("strong", entry.role === "bot" ? "ragbot" : author.nick || author.globalName || author.username || "user"), node("div", entry.content));
      return card;
    }));
    $("transcript").hidden = !entries.length;
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
    for (const exchange of result.ai.filter((item) => item.error)) $("replies").append(node("p", `Model failed: ${exchange.error}. Inspect AI responses below.`));
    if (!$("replies").childElementCount) $("replies").append(node("p", "No reply was sent. Inspect worker logs and database effects below."));
  };
  const run = async (task, { validate = false } = {}) => {
    if (busy) return;
    if (validate) {
      for (const id of overrideFields) {
        const input = $(id);
        if (input.disabled || input.closest("[hidden]") || input.checkValidity()) continue;
        for (let parent = input.parentElement; parent; parent = parent.parentElement) {
          if (parent.tagName === "DETAILS") parent.open = true;
        }
        input.reportValidity();
        return;
      }
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
    return { target: baseline?.target ?? "local", baseRevision: baseline?.revision, identity: user, modsRole: $("modsRole").checked, guildId: value("guildId"), channelId: value("channelId"), page, settings: editsSettings() ? draftSettings() : undefined };
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
        ...input, content, botUserId: value("botUserId"), mentionBot: $("mentionBot").checked,
        transcript: entries, replyToId: $("replyLast").checked ? lastBot?.id : undefined,
      });
      entries.push({ id: result.message.id, role: "user", content: result.message.content, author: input.identity });
      for (const reply of result.replies) entries.push({ id: reply.id ?? snowflake(), role: "bot", content: reply.content });
      $("content").value = "";
      $("replay-status").hidden = true;
      renderTranscript();
      renderResult(result);
      status(result.ai.some(item => item.error) ? "Model request failed. See the output for details." : `${result.replies.length ? "Reply received" : "No reply"} in ${result.durationMs} ms.`, result.ai.some(item => item.error));
    }, { validate: true });
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
    }, { validate: true });
  });
  const updateSettings = () => {
    if (!meta) return;
    const { chat: config, image } = meta.settings;
    const temperatureSpec = catalog.chat.find(m => m.id === (value("model") || config.model))?.temperature;
    $("temperature-control").hidden = !["chat"].includes(page);
    $("temperature").disabled = $("temperature-slider").disabled = busy || !temperatureSpec;
    $("temperature-current").hidden = false;
    if (temperatureSpec) {
      for (const id of ["temperature", "temperature-slider"]) {
        $(id).min = temperatureSpec.minimum; $(id).max = temperatureSpec.maximum;
      }
      const current = value("temperature") === "" ? config.temperature : Number(value("temperature"));
      $("temperature-slider").value = current;
      $("temperature-value").textContent = current;
      $("temperature-current").textContent = `${temperatureSpec.minimum}–${temperatureSpec.maximum} · Lower is more consistent; higher is more varied. Saved: ${config.temperature}`;
    } else {
      $("temperature-value").textContent = "";
      $("temperature-current").textContent = "Not supported by the selected model.";
    }
    $("temperature").placeholder = config.temperature;
    for (const [id, key] of [["model", "model"], ["historyLimit", "historyLimit"]]) {
      if ($(id).tagName === "INPUT") $(id).placeholder = config[key];
      $(`${id}-current`).hidden = !value(id) || String(value(id)) === String(config[key]);
      $(`${id}-current`).textContent = `Saved: ${config[key]}${value(id) && String(value(id)) !== String(config[key]) ? " · Unsaved: " + value(id) : ""}`;
    }
    for (const id of ["systemPrompt"]) $(`${id}-current`).textContent = value(id) ? "Current: your custom prompt" : "Current: saved prompt (shown below)";
    const profileName = value("imageProfile") || image.activeProfile;
    const profile = image.profiles[profileName];
    $("imageProfile-current").textContent = `Current: ${profileName} · Default: ${image.activeProfile}`;
    const selectedImage = value("imageModel") || profile.model;
    const imageModel = catalog.image.find(m => m.id === selectedImage);
    if ($("imageModel").options[0]) {
      $("imageModel").options[0].textContent = `${catalog.image.find(m => m.id === profile.model)?.name || profile.model} (saved)`;
      $("imageModel").options[0].disabled = !catalog.image.some(m => m.id === profile.model);
    }
    $("imageModel-current").hidden = selectedImage === profile.model;
    $("imageModel-current").textContent = `Saved for ${profileName}: ${profile.model}${selectedImage !== profile.model ? " · Unsaved: " + selectedImage : ""}`;


    $("review-settings").textContent = baseline?.target === "live" ? "Review & save to live bot" : "Review & save locally";

    for (const [id, field] of imageParameterFields) {
      const spec = imageModel?.parameters?.[field];
      $(id).closest("label").hidden = !spec;
      const previous = value(id);
      const saved = profile.parameters[field];
      const fallback = spec ? ((!spec.enum || spec.enum.includes(saved)) ? saved : spec.default) : undefined;
      $(id).replaceChildren(new Option(spec ? `Default (${fallback || "model default"})` : "Not supported by this model", ""), ...(spec?.enum ?? []).map(option => new Option(option, option)));
      if (spec?.enum?.includes(previous)) $(id).value = previous;
      $(id).disabled = busy || !spec;
      $(`${id}-current`).textContent = spec ? `Current: ${value(id) || fallback || "model default"} · Available: ${(spec.enum ?? []).join(", ") || "model default"}` : "This parameter is not sent to this model.";
    }
    const canChat = catalog.chat.some(m => m.id === (value("model") || config.model));
    const canImage = Boolean(imageModel);
    $("review-settings").disabled = busy || !baseline || !Object.keys(overrides()).length;
    $("send").disabled = busy || !baseline || !canChat;
    $("run-command").disabled = busy || !baseline || (page === "bicture" && !canImage);
    $("default-prompt").textContent = config.prompt;
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
    $("model-panel").hidden = !["chat", "bicture"].includes(page);
    $("chat-model-field").hidden = image;
    $("image-model-field").hidden = !image;
    $("history-panel").hidden = !["chat", "bicture"].includes(page);
    $("replay-status").hidden = true;
    clearHistory();
    $("chat-settings").hidden = image;
    $("image-settings").hidden = !image;
    $("page-title").textContent = chat ? "Chat playground" : `/${page}`;
    $("page-description").textContent = chat || image ? "Test prompts locally. Save model changes to apply them to the bot." : meta.commands.find(c => c.name === page).description;
    $("result-title").textContent = image ? "Generated image" : "Output";
    document.title = `${chat ? "Chat" : "/" + page} · ragbot dev studio`;
    for (const link of $("pages").querySelectorAll("a")) {
      if (link.dataset.page === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    const draft = state.pages[page] ?? {};
    for (const id of overrideFields) {
      if (["model", "imageModel"].includes(id) && draft[id] && ![...$(id).options].some(o => o.value === draft[id])) {
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
    status(baseline ? "Ready." : "Settings unavailable. Reload or choose Local sandbox.", !baseline);
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
  $("temperature-slider").addEventListener("input", () => {
    $("temperature").value = $("temperature-slider").value;
    $("temperature").dispatchEvent(new Event("input", { bubbles: true }));
  });
  $("content").addEventListener("input", save);
  $("reset-settings").addEventListener("click", () => { invalidateReview(); for (const id of overrideFields) $(id).value = ""; save(); updateSettings(); });
  $("edit-prompt").addEventListener("click", () => { $("systemPrompt").value = meta.settings.chat.prompt; invalidateReview(); updateSettings(); save(); $("systemPrompt").focus(); });
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
    json("config", await api("config", { target: baseline?.target ?? "local", baseRevision: baseline?.revision, page, settings: editsSettings() ? draftSettings() : undefined }));
    $("config-panel").hidden = false;
    $("config-panel").open = true;
    $("debug-panel").open = true;
    status("Showing resolved configuration.");
  }));
  const loadHistory = async (older = false) => {
    if (!older) clearHistory();
    $("history-status").textContent = "Fetching prompt history…";
    try {
      const result = await api("history", {
        target: value("history-target"), page: page === "bicture" ? "bicture" : "chat",
        search: value("history-search"), before: older ? historyNext : null,
      });
      let firstNewCard;
      for (const entry of result.entries) {
        const card = node("details", "", "history-card");
        firstNewCard ??= card;
        const timestamp = new Date(entry.created_at.includes("T") ? entry.created_at : entry.created_at.replace(" ", "T") + "Z");
        const when = Number.isNaN(timestamp.getTime()) ? entry.created_at : timestamp.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        const summary = node("summary", "");
        const kind = { channel_reply: "Chat", bicture: "/bicture" }[entry.kind] || entry.kind;
        summary.append(node("span", entry.prompt, "history-preview"), node("span", `${when} · ${entry.requester_username || "user"} · ${kind}${entry.status !== "ok" ? " · Failed" : ""}`, "history-meta"));
        card.append(summary, node("p", `Model: ${entry.model}`), node("pre", entry.prompt));
        if (entry.response_text) {
          const response = node("details", "", "history-response");
          response.append(node("summary", "Previous response"), node("pre", entry.response_text));
          card.append(response);
        }
        const button = node("button", "Load prompt for replay");
        button.type = "button";
        button.addEventListener("click", () => {
          if (busy) return;
          const input = page === "chat" ? $("content") : $("command-options").querySelector('[data-option="prompt"][data-field="value"]');
          input.value = entry.prompt;
          if (page === "chat") {
            // Isolate a replay from an unrelated local conversation.
            $("channelId").value = snowflake();
            $("mentionBot").checked = true;
            $("replyLast").checked = false;
            renderTranscript();
          }
          $("replay-status").textContent = `Loaded from ${value("history-target") === "live" ? "Live bot" : "Local sandbox"} · ${when}. Uses your current settings; previous conversation context is not included.`;
          $("replay-status").hidden = false;
          $("history-panel").open = false;
          save(); input.focus({ preventScroll: true });
          $("replay-status").scrollIntoView({ block: "start" });
          status("Prompt loaded. Review it, then send or generate with your current settings.");
        });
        const actions = node("div", "", "history-actions");
        actions.append(button);
        card.append(actions);
        $("history-entries").append(card);
      }
      historyNext = result.next;
      $("more-history").hidden = historyNext === null;
      if (older) firstNewCard?.scrollIntoView({ block: "nearest" });
      $("history-status").textContent = $("history-entries").childElementCount
        ? `${$("history-entries").childElementCount} saved prompts · newest first · times shown in your timezone.`
        : value("history-search") ? "No saved prompts match your search. Try another phrase."
        : page === "bicture" ? "No saved image prompts in this source yet."
        : "No saved chat prompts in this source yet.";
      status("Prompt history loaded.");
    } catch (error) {
      $("history-status").textContent = error.message;
      throw error;
    }
  };
  $("load-history").addEventListener("click", () => run(() => loadHistory()));
  $("more-history").addEventListener("click", () => run(() => loadHistory(true)));
  $("history-target").addEventListener("change", clearHistory);
  $("history-search").addEventListener("input", clearHistory);
  $("history-search").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); void run(() => loadHistory()); }
  });
  const loadModels = async (refresh = false) => {
    $("catalog-status").textContent = "Checking Cloudflare-credit model availability…";
    try {
      catalog = await api("models", { target: baseline?.target ?? "local", refresh });
      $("catalog-status").textContent = `${catalog.chat.length} compatible chat models · ${catalog.image.length} image models · checked ${new Date(catalog.checkedAt * 1000).toLocaleTimeString()}.`;
    } catch (error) {
      catalog = { chat: [], image: [] };
      $("catalog-status").textContent = error.message;
    }
    const previousProfile = value("imageProfile");
    const { chat, image } = meta.settings;
    $("imageProfile").replaceChildren(new Option(`Default (${image.activeProfile})`, ""), ...Object.entries(image.profiles).filter(([, p]) => catalog.image.some(m => m.id === p.model)).map(([name]) => new Option(name, name)));
    $("imageProfile").options[0].disabled = !catalog.image.some(m => m.id === image.profiles[image.activeProfile].model);
    if ([...$("imageProfile").options].some(o => o.value === previousProfile)) $("imageProfile").value = previousProfile;
    for (const [id, group, fallback] of [["model", "chat", chat.model], ["imageModel", "image", image.profiles[image.activeProfile].model]]) {
      const previous = value(id);
      const eligibleDefault = catalog[group].some(m => m.id === fallback);
      const defaultOption = new Option(eligibleDefault ? `${catalog[group].find(m => m.id === fallback)?.name || fallback} (saved)` : "Choose an available model", "");
      defaultOption.disabled = !eligibleDefault;
      const groups = new Map();
      for (const model of [...catalog[group]].sort((a, b) => a.name.localeCompare(b.name))) {
        const provider = model.provider || "Models";
        if (!groups.has(provider)) {
          const options = document.createElement("optgroup"); options.label = provider;
          groups.set(provider, options);
        }
        const option = new Option(model.name, model.id); option.title = model.id;
        groups.get(provider).append(option);
      }
      $(id).replaceChildren(defaultOption, ...groups.values());
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
      meta.settings = baseline.settings;
      $("settings-status").textContent = `${baseline.target === "live" ? "Live bot" : "Local sandbox"} · changes are drafts until saved.`;
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
    const draft = { target: baseline.target, baseRevision: baseline.revision, settings: draftSettings(), page };
    const result = await api("settings/review", draft);
    review = { ...draft, reviewId: result.reviewId };
    $("review-title").textContent = baseline.target === "live" ? "Review production changes" : "Review local sandbox changes";
    const labels = { "chat.prompt": "Chat system prompt" };
    const shown = (setting) => setting.replace(/^image\.profiles\./, "image / ").replaceAll(".", " / ");
    const text = (value) => value === null ? "—" : typeof value === "string" ? value : JSON.stringify(value);
    const table = node("table", "");
    const head = node("tr", "");
    head.append(node("th", "Setting"), node("th", "Saved"), node("th", "After save"));
    table.append(head);
    const prompts = [];
    for (const change of result.changes) {
      if (change.setting === "chat.prompt") {
        const item = node("section", "", "settings-change");
        item.append(node("h4", labels[change.setting]), node("strong", "Saved"), node("pre", text(change.before)), node("strong", "After save"), node("pre", text(change.after)));
        prompts.push(item);
        continue;
      }
      const row = node("tr", "");
      row.append(node("th", shown(change.setting)), node("td", text(change.before)), node("td", text(change.after)));
      table.append(row);
    }
    $("settings-changes").replaceChildren(...(table.rows.length > 1 ? [table] : []), ...prompts);
    $("save-settings").textContent = baseline.target === "live" ? "Save to live bot" : "Save to local sandbox";
    $("save-settings").hidden = !result.changes.length;
    if (!result.changes.length) $("settings-changes").append(node("p", "No changes to save."));
    $("settings-review").hidden = false;
    $("settings-review").scrollIntoView({ block: "nearest" });
    status("Review the changes before saving.");
  }, { validate: true }));
  $("save-settings").addEventListener("click", () => run(async () => {
    if (!review) throw new Error("Review changes before saving.");
    baseline = await api("settings/save", review);
    meta.settings = baseline.settings;
    invalidateReview();
    for (const id of overrideFields) $(id).value = "";
    save();
    await loadModels();
    $("settings-status").textContent = `Saved to ${baseline.target === "live" ? "live bot" : "local sandbox"}. New requests use these settings now.`;
    status("Settings saved. No redeploy needed for future setting changes.");
  }));
  const boot = async () => {
    meta = await api("meta");
    try { await loadSettings(); } catch { /* Keep local settings and history accessible. */ }
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
    const links = [{name: "chat"}, ...meta.commands].map(command => {
      const link = node("a", command.name === "chat" ? "Chat" : `/${command.name}`);
      link.href = `#/${command.name}`;
      link.dataset.page = command.name;
      return link;
    });
    const more = node("details", "", "nav-more"), menu = node("div", "");
    more.append(node("summary", "Other commands"), menu);
    for (const link of links.filter(link => !["chat", "bicture"].includes(link.dataset.page))) menu.append(link);
    $("pages").replaceChildren(...["chat", "bicture"].map(name => links.find(link => link.dataset.page === name)).filter(Boolean), more);
    menu.addEventListener("click", () => { more.open = false; });

    state.pages.chat ??= {};
    for (const id of overrideFields) $(id).value = state.pages.chat[id] ?? "";
    $("content").value = state.pages.chat.content ?? "";
    $("connection").textContent = "Connected · local testing";
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
