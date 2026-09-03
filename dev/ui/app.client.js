// ragbot dev console — plain browser JS, no build step. Served by dev/index.ts.
(() => {
  "use strict";

  const STORAGE_KEY = "ragbot-dev-console";
  const DISCORD_EPOCH = 1420070400000n;
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------

  const defaultState = () => ({
    page: "mention",
    profiles: [],
    activeProfile: null,
    ids: { botUserId: "", guildId: "", channelId: "" },
    mode: "channel",
    mentionBot: true,
    replyLast: false,
    overrides: { model: "", temperature: "", maxTokens: "", historyLimit: "", webSearchModel: "" },
    configSource: "bundled",
    providerFilter: "",
    chatOnly: true,
    showKeyRequired: false,
    // Models the gateway has rejected in this browser (id -> short reason), on
    // top of the catalog's provider-level rule. Cleared per model by a
    // successful run or probe.
    modelIssues: {},
    transcripts: {},
    slash: { command: "", values: {} },
    layout: null,
  });

  // ---------- resizable layout ----------

  // Column widths are fractions of the layout width; tile heights are
  // flex-grow weights within their column. Both persist in state.layout.
  const DEFAULT_LAYOUT = () => ({
    cols: { left: 0.34, middle: 0.33, right: 0.33 },
    rows: {
      "identity-card": 1.25,
      "chat-card": 1.4,
      "slash-card": 1.2,
      "payload-card": 1,
      "ai-request-card": 1,
      "ai-response-card": 1.4,
      "parsed-card": 0.6,
      "effects-card": 0.8,
    },
  });
  const MIN_COL_FRACTION = 0.16;
  const MIN_ROW_SHARE = 0.12;

  const layoutState = () => {
    if (!state.layout || !state.layout.cols || !state.layout.rows) {
      state.layout = DEFAULT_LAYOUT();
    }
    return state.layout;
  };

  const visibleCards = (column) =>
    [...column.querySelectorAll(":scope > .card")].filter((card) => !card.classList.contains("hidden"));

  const applyLayout = () => {
    const layout = layoutState();
    const defaults = DEFAULT_LAYOUT();
    for (const column of document.querySelectorAll("#layout > .col")) {
      const fraction = layout.cols[column.dataset.col] ?? defaults.cols[column.dataset.col];
      column.style.flex = `0 0 calc(${(fraction * 100).toFixed(3)}% - 7px)`;

      // Rebuild the horizontal gutters so only visible neighbours get one.
      for (const gutter of column.querySelectorAll(":scope > .gutter.h")) {
        gutter.remove();
      }
      const cards = visibleCards(column);
      cards.forEach((card, index) => {
        card.style.flexGrow = String(layout.rows[card.id] ?? defaults.rows[card.id] ?? 1);
        if (index > 0) {
          const gutter = document.createElement("div");
          gutter.className = "gutter h";
          gutter.title = "Drag to resize";
          gutter.dataset.before = cards[index - 1].id;
          gutter.dataset.after = card.id;
          column.insertBefore(gutter, card);
        }
      });
    }
  };

  const startDrag = (event) => {
    const gutter = event.target.closest(".gutter");
    if (!gutter || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const layout = layoutState();
    const vertical = gutter.classList.contains("v");
    const before = vertical
      ? document.querySelector(`#layout > .col[data-col="${gutter.dataset.before}"]`)
      : $(gutter.dataset.before);
    const after = vertical
      ? document.querySelector(`#layout > .col[data-col="${gutter.dataset.after}"]`)
      : $(gutter.dataset.after);
    if (!before || !after) {
      return;
    }
    const container = $("layout");
    const start = vertical ? event.clientX : event.clientY;
    const beforeRect = before.getBoundingClientRect();
    const afterRect = after.getBoundingClientRect();
    const beforeSize = vertical ? beforeRect.width : beforeRect.height;
    const afterSize = vertical ? afterRect.width : afterRect.height;
    const startValues = vertical
      ? [layout.cols[before.dataset.col], layout.cols[after.dataset.col]]
      : [Number(before.style.flexGrow) || 1, Number(after.style.flexGrow) || 1];
    const pairTotal = startValues[0] + startValues[1];
    gutter.classList.add("active");
    container.classList.add("dragging");
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";

    const move = (moveEvent) => {
      const delta = (vertical ? moveEvent.clientX : moveEvent.clientY) - start;
      // Units per pixel: fractions of the container width, or weight per pixel
      // of the pair's combined height.
      const perPixel = vertical ? 1 / container.clientWidth : pairTotal / Math.max(1, beforeSize + afterSize);
      const minimum = vertical ? MIN_COL_FRACTION : pairTotal * MIN_ROW_SHARE;
      const next = Math.min(pairTotal - minimum, Math.max(minimum, startValues[0] + delta * perPixel));
      if (vertical) {
        layout.cols[before.dataset.col] = next;
        layout.cols[after.dataset.col] = pairTotal - next;
      } else {
        layout.rows[before.id] = next;
        layout.rows[after.id] = pairTotal - next;
      }
      applyLayout();
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      gutter.classList.remove("active");
      container.classList.remove("dragging");
      document.body.style.cursor = "";
      saveState();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  };

  const resetLayout = () => {
    state.layout = DEFAULT_LAYOUT();
    saveState();
    applyLayout();
  };

  const loadState = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...defaultState(), ...JSON.parse(raw) } : defaultState();
    } catch {
      return defaultState();
    }
  };
  const state = loadState();
  const saveState = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage is a convenience; the page works without it.
    }
  };

  let meta = null;
  let catalog = { models: [], source: "fallback" };
  let prodKv = null;
  let busy = false;
  let lastResult = null;

  const snowflake = () =>
    (((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | BigInt(Math.floor(Math.random() * 4096))).toString();

  // ---------- helpers ----------

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

  const highlightJson = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (text === undefined) {
      return "—";
    }
    return escapeHtml(text).replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        if (match.startsWith('"')) {
          return match.endsWith(":") ? `<span class="j-key">${match}</span>` : `<span class="j-str">${match}</span>`;
        }
        if (/^(true|false|null)$/.test(match)) {
          return `<span class="j-lit">${match}</span>`;
        }
        return `<span class="j-num">${match}</span>`;
      },
    );
  };

  const setJson = (element, value) => {
    element.innerHTML = value === undefined || value === null ? "—" : highlightJson(value);
  };

  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    return payload;
  };

  const fmtCost = (perToken) => (perToken === null || perToken === undefined ? "?" : `$${(perToken * 1e6).toFixed(2)}`);
  const fmtTime = (iso) => {
    if (!iso) {
      return "";
    }
    const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  };
  const pathOf = (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };

  const numberOrUndefined = (value) => {
    const parsed = Number(value);
    return value === "" || value === null || value === undefined || !Number.isFinite(parsed) ? undefined : parsed;
  };

  // ---------- identity / profiles ----------

  const identityInputs = ["profile-name", "user-id", "username", "global-name", "nick"];

  const currentIdentity = () => ({
    userId: $("user-id").value.trim(),
    username: $("username").value.trim(),
    globalName: $("global-name").value.trim() || null,
    nick: $("nick").value.trim() || null,
  });

  const renderProfiles = () => {
    const select = $("profile-select");
    select.innerHTML = `<option value="">— unsaved —</option>${state.profiles
      .map((profile) => `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</option>`)
      .join("")}`;
    select.value = state.activeProfile ?? "";
  };

  const applyProfile = (profile) => {
    $("profile-name").value = profile?.name ?? "";
    $("user-id").value = profile?.userId ?? "";
    $("username").value = profile?.username ?? "";
    $("global-name").value = profile?.globalName ?? "";
    $("nick").value = profile?.nick ?? "";
  };

  const saveProfile = () => {
    const name = $("profile-name").value.trim() || $("username").value.trim();
    if (!name) {
      return;
    }
    const profile = { name, ...currentIdentity() };
    const index = state.profiles.findIndex((existing) => existing.name === name);
    if (index >= 0) {
      state.profiles[index] = profile;
    } else {
      state.profiles.push(profile);
    }
    state.activeProfile = name;
    $("profile-name").value = name;
    renderProfiles();
    saveState();
  };

  const deleteProfile = () => {
    if (!state.activeProfile) {
      return;
    }
    state.profiles = state.profiles.filter((profile) => profile.name !== state.activeProfile);
    state.activeProfile = null;
    renderProfiles();
    saveState();
  };

  // Keep the draft identity around even when unsaved.
  const rememberDraft = () => {
    state.draft = { name: $("profile-name").value, ...currentIdentity() };
    saveState();
  };

  // ---------- models ----------

  const needsOwnKey = (model) => model.access === "key-required" || Boolean(state.modelIssues[model.id]);

  const accessLabel = (model) => {
    if (state.modelIssues[model.id]) {
      return `unavailable: ${state.modelIssues[model.id]}`;
    }
    return { included: "billed via gateway", byok: "your stored key", "key-required": "needs own key" }[model.access] ?? "";
  };

  // Classifies a failed model exchange into a short, persistent reason, or null
  // when the failure looks transient (rate limits, upstream outages).
  const issueFrom = (exchange) => {
    const response = exchange.response ?? {};
    const status = response.status;
    const body = response.body ?? {};
    const inner = body.error && typeof body.error === "object" ? body.error : body;
    const text = [body.code, body.error, body.message, inner.code, inner.message, exchange.error]
      .filter((value) => typeof value === "string")
      .join(" ");
    if ((status === 401 || status === 403) && /credential|unauthenticated|api key/i.test(text)) {
      return "needs own key (no credentials)";
    }
    if (status === 404 || /not_found|does not exist|deprecated/i.test(text)) {
      return "not found / retired at provider";
    }
    if (status === 400 && /unsupported parameter|max_completion_tokens/i.test(text)) {
      return "rejects the bot's request shape (max_tokens)";
    }
    if (status === 400) {
      return `rejected (400): ${text.slice(0, 60)}`;
    }
    return null;
  };

  const renderModelList = () => {
    const chatOnly = $("chat-only").checked;
    const showKeyRequired = $("show-key-required").checked;
    const provider = $("provider-filter").value;
    const models = catalog.models.filter(
      (model) =>
        (!chatOnly || model.kind === "chat") &&
        (showKeyRequired || !needsOwnKey(model)) &&
        (!provider || model.provider === provider),
    );
    $("model-list").innerHTML = models
      .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(`${model.provider} · ${fmtCost(model.costIn)}/${fmtCost(model.costOut)} per 1M · ${accessLabel(model)}`)}</option>`)
      .join("");
    renderModelCost();
  };

  const renderModelCost = () => {
    const id = $("model").value.trim() || meta?.config?.responseModel || "";
    const model = catalog.models.find((entry) => entry.id === id);
    const cost = $("model-cost");
    cost.classList.remove("warn");
    if (!id) {
      cost.textContent = "";
    } else if (model) {
      cost.textContent = `${fmtCost(model.costIn)} in · ${fmtCost(model.costOut)} out /1M · ${accessLabel(model)}`;
      cost.title = `${model.provider}: AI Gateway catalog price per 1M tokens. ${accessLabel(model)}.`;
      cost.classList.toggle("warn", needsOwnKey(model));
    } else {
      cost.textContent = catalog.source === "gateway" ? "not in gateway catalog" : "catalog unavailable";
    }
  };

  // Remember which model ids the gateway rejects (and forget them again after a
  // success) so the picker hides and labels them from then on.
  const learnFromExchanges = (exchanges) => {
    let changed = false;
    for (const exchange of exchanges ?? []) {
      if (!exchange.model || exchange.model === "unknown") {
        continue;
      }
      const failed = exchange.error || (exchange.response?.status ?? 200) >= 400;
      if (failed) {
        const issue = issueFrom(exchange);
        if (issue && state.modelIssues[exchange.model] !== issue) {
          state.modelIssues[exchange.model] = issue;
          changed = true;
        }
      } else if (state.modelIssues[exchange.model]) {
        delete state.modelIssues[exchange.model];
        changed = true;
      }
    }
    if (changed) {
      saveState();
      renderModelList();
    }
  };

  // Describes the first failed model exchange of a run, for the output panel.
  const aiFailureSummary = (exchanges) => {
    const failed = (exchanges ?? []).find((exchange) => exchange.error || (exchange.response?.status ?? 200) >= 400);
    if (!failed) {
      return null;
    }
    const status = failed.response?.status ? `HTTP ${failed.response.status}` : "error";
    const body = failed.response?.body;
    const detail = body ? JSON.stringify(body).slice(0, 400) : failed.error ?? "";
    return `${failed.model} → ${status}: ${detail}`;
  };

  const probeModelId = async () => {
    const model = $("model").value.trim() || meta?.config?.responseModel;
    if (!model || busy) {
      return;
    }
    const cost = $("model-cost");
    cost.textContent = `testing ${model}…`;
    cost.classList.remove("warn");
    $("probe-model").disabled = true;
    try {
      const result = await api("/api/models/probe", { method: "POST", body: JSON.stringify({ model }) });
      learnFromExchanges(result.ai);
      if (result.ok) {
        cost.textContent = `✓ ${model} works (${result.responseModel ?? "?"}, ${result.durationMs} ms)`;
      } else {
        cost.textContent = `✗ ${result.error ?? `HTTP ${result.status}`}`;
        cost.classList.add("warn");
      }
      cost.title = cost.textContent;
    } catch (error) {
      cost.textContent = `✗ ${error.message}`;
      cost.classList.add("warn");
    } finally {
      $("probe-model").disabled = false;
    }
  };

  const loadModels = async (refresh = false) => {
    try {
      catalog = await api(`/api/models${refresh ? "?refresh=1" : ""}`);
    } catch (error) {
      catalog = { models: [], source: "fallback", error: error.message };
    }
    const providers = [...new Set(catalog.models.map((model) => model.provider))].sort();
    const filter = $("provider-filter");
    filter.innerHTML = `<option value="">all providers</option>${providers.map((provider) => `<option>${escapeHtml(provider)}</option>`).join("")}`;
    filter.value = providers.includes(state.providerFilter) ? state.providerFilter : "";
    renderModelList();
    renderPills();
  };

  // ---------- toolbar / overrides ----------

  const readOverrides = () => {
    state.overrides = {
      model: $("model").value.trim(),
      temperature: $("temperature").value,
      maxTokens: $("max-tokens").value,
      historyLimit: $("history-limit").value,
      webSearchModel: $("web-search-model").value.trim(),
    };
    state.configSource = $("config-source").value;
    state.providerFilter = $("provider-filter").value;
    state.chatOnly = $("chat-only").checked;
    state.showKeyRequired = $("show-key-required").checked;
    saveState();
  };

  const overridesPayload = () => ({
    model: state.overrides.model || undefined,
    temperature: numberOrUndefined(state.overrides.temperature),
    maxTokens: numberOrUndefined(state.overrides.maxTokens),
    historyLimit: numberOrUndefined(state.overrides.historyLimit),
    webSearchModel: state.overrides.webSearchModel || undefined,
    kv: state.configSource === "production" && prodKv ? prodKv.values : undefined,
  });

  const applyOverridesToInputs = () => {
    const config = meta?.config ?? {};
    $("model").value = state.overrides.model || "";
    $("model").placeholder = config.responseModel ?? "provider/model";
    $("temperature").value = state.overrides.temperature ?? "";
    $("temperature").placeholder = config.temperature ?? "";
    $("max-tokens").value = state.overrides.maxTokens ?? "";
    $("max-tokens").placeholder = config.maxTokens ?? "";
    $("history-limit").value = state.overrides.historyLimit ?? "";
    $("history-limit").placeholder = config.historyLimit ?? "";
    $("web-search-model").value = state.overrides.webSearchModel || "";
    $("web-search-model").placeholder = config.askWebSearchModel ?? "";
    $("config-source").value = state.configSource;
    $("chat-only").checked = state.chatOnly;
    $("show-key-required").checked = state.showKeyRequired;
    renderModelCost();
  };

  const ensureProdConfig = async () => {
    if (state.configSource !== "production") {
      return;
    }
    if (!prodKv) {
      prodKv = await api("/api/prod/config");
    }
  };

  const showResolvedConfig = async () => {
    const dialog = $("config-dialog");
    setJson($("config-json"), "loading…");
    dialog.showModal();
    try {
      await ensureProdConfig();
      const config = await api("/api/config", { method: "POST", body: JSON.stringify({ overrides: overridesPayload() }) });
      setJson($("config-json"), { source: state.configSource, ...config });
    } catch (error) {
      setJson($("config-json"), { error: error.message });
    }
  };

  // ---------- pills ----------

  const renderPills = () => {
    if (!meta) {
      return;
    }
    const pills = [
      { text: `gateway ${meta.gatewayId}`, cls: meta.hasAigToken ? "ok" : "bad", title: meta.hasAigToken ? "CF_AIG_TOKEN present" : "CF_AIG_TOKEN missing" },
      { text: meta.hasProdAccess ? "prod: read access" : "prod: no token", cls: meta.hasProdAccess ? "ok" : "warn", title: "CLOUDFLARE_API_TOKEN for D1/KV reads" },
      { text: `models: ${catalog.source}${catalog.models.length ? ` (${catalog.models.length})` : ""}`, cls: catalog.source === "gateway" ? "ok" : "warn", title: catalog.error ?? "" },
      {
        text: `provider keys: ${Object.keys(catalog.byokProviders ?? {}).length || "none"}`,
        cls: catalog.byokError ? "warn" : "",
        title: catalog.byokError ?? `Unified Billing: ${(catalog.unifiedBillingProviders ?? []).join(", ")}${Object.keys(catalog.byokProviders ?? {}).length ? `; BYOK: ${Object.entries(catalog.byokProviders).map(([p, a]) => `${p} (${a.join(", ")})`).join(", ")}` : ""}`,
      },
      { text: "local D1 · stubbed Discord", cls: "", title: "Model calls are real; Discord REST is answered locally" },
    ];
    $("status-pills").innerHTML = pills
      .map((pill) => `<span class="pill ${pill.cls}" title="${escapeHtml(pill.title)}">${escapeHtml(pill.text)}</span>`)
      .join("");
  };

  // ---------- transcript ----------

  const transcript = () => {
    const channelId = $("channel-id").value.trim();
    if (!state.transcripts[channelId]) {
      state.transcripts[channelId] = [];
    }
    return state.transcripts[channelId];
  };

  const renderContent = (content) =>
    escapeHtml(content).replace(/&lt;@!?(\d+)&gt;/g, (match, id) => {
      const name = id === $("bot-user-id").value.trim() ? "@ragbot" : `@${id}`;
      return `<span class="mention">${name}</span>`;
    });

  const renderTranscript = () => {
    const entries = transcript();
    const container = $("transcript");
    if (entries.length === 0) {
      container.innerHTML = `<div class="empty">No messages in this channel yet.<br>Channel mode sends a fresh @mention each time; thread modes replay this transcript as the thread history.</div>`;
      return;
    }
    container.innerHTML = entries
      .map((entry) => {
        const who = entry.role === "bot" ? "ragbot" : (entry.author?.nick || entry.author?.globalName || entry.author?.username || "user");
        const initial = who.slice(0, 1);
        const replyTo = entry.replyToId ? entries.find((candidate) => candidate.id === entry.replyToId) : null;
        return `<div class="msg ${entry.role} ${entry.status ?? ""}" data-id="${escapeHtml(entry.id)}">
          <div class="avatar">${escapeHtml(initial)}</div>
          <div>
            ${replyTo ? `<div class="replyto">↩ replying to ${escapeHtml(replyTo.role === "bot" ? "ragbot" : who)}: ${escapeHtml(replyTo.content.slice(0, 80))}</div>` : ""}
            <div class="who">${escapeHtml(who)}${entry.role === "bot" ? '<span class="tag">BOT</span>' : ""}<span class="when">${escapeHtml(entry.at ? new Date(entry.at).toLocaleTimeString() : "")}</span></div>
            <div class="body">${renderContent(entry.content)}</div>
          </div>
        </div>`;
      })
      .join("");
    container.scrollTop = container.scrollHeight;
  };

  const composerHint = () => {
    const mode = $("mode").value;
    const hint = $("composer-hint");
    if (mode === "channel") {
      hint.textContent = "channel_reply: no history is fetched, only the message (and a reply reference, if set).";
    } else if (mode === "thread") {
      hint.textContent = "thread_reply: the first transcript message seeds the thread's initial prompt; the rest is served as history.";
    } else {
      hint.textContent = "/ask thread: same as thread reply, plus web-search routing when the prompt looks like it needs live info.";
    }
    $("web-search-wrap").classList.toggle("hidden", mode !== "ask_thread");
    $("mention-bot").checked = mode === "channel" ? state.mentionBot : $("mention-bot").checked;
  };

  // ---------- result panels ----------

  const renderExchanges = (exchanges, container, side) => {
    if (!exchanges || exchanges.length === 0) {
      container.innerHTML = `<pre class="json">—</pre>`;
      return;
    }
    container.innerHTML = exchanges
      .map((exchange, index) => {
        const label = `#${index + 1} ${exchange.transport} · ${exchange.model} · ${exchange.durationMs} ms${exchange.error ? ` · ${exchange.error}` : ""}`;
        if (side === "request") {
          const request = exchange.request ?? {};
          const head = request.url
            ? `<div class="kv"><span>${escapeHtml(request.method)}</span><b>${escapeHtml(request.url)}</b>${Object.entries(request.headers ?? {})
              .map(([key, value]) => `<span>${escapeHtml(key)}</span><b>${escapeHtml(value)}</b>`)
              .join("")}</div>`
            : `<div class="kv"><span>binding</span><b>env.AI.run(${escapeHtml(request.model ?? "")})</b></div>`;
          const body = request.url ? request.body : { input: request.input, options: request.options };
          return `<div class="exchange-head"><b>${escapeHtml(label)}</b></div>${head}<pre class="json">${highlightJson(body)}</pre>`;
        }
        const response = exchange.response ?? (exchange.error ? { error: exchange.error } : null);
        const status = response && response.status !== undefined ? `HTTP ${response.status}` : "";
        const body = response && response.status !== undefined ? response.body : response;
        return `<div class="exchange-head"><b>${escapeHtml(label)}</b><span>${escapeHtml(status)}</span></div><pre class="json">${highlightJson(body)}</pre>`;
      })
      .join("");
  };

  const attachmentHtml = (attachment) => {
    const label = `${attachment.name} · ${attachment.contentType} · ${(attachment.bytes / 1024).toFixed(1)} KiB`;
    if (attachment.dataUrl && attachment.contentType.startsWith("image/")) {
      return `<div class="attachment"><img src="${attachment.dataUrl}" alt="${escapeHtml(attachment.name)}"><div class="sub">${escapeHtml(label)}</div></div>`;
    }
    if (attachment.dataUrl && attachment.contentType.startsWith("audio/")) {
      return `<div class="attachment"><audio controls src="${attachment.dataUrl}"></audio><div class="sub">${escapeHtml(label)}</div></div>`;
    }
    return `<div class="attachment sub">${escapeHtml(label)}</div>`;
  };

  const renderEffects = (result) => {
    const effects = $("effects");
    const calls = result.calls ?? [];
    const logs = result.logs ?? [];
    const interaction = result.db?.interaction;
    const spend = result.db?.spendEvents ?? [];
    const callItems = calls
      .map((call) => {
        const status = call.response?.status ?? "";
        return `<li class="${call.routed}">${escapeHtml(call.method)} ${escapeHtml(pathOf(call.url))} → ${escapeHtml(String(status))} <span class="${call.routed}">[${call.routed}]</span>${call.note ? ` <span class="stub">${escapeHtml(call.note)}</span>` : ""} <span class="stub">${call.durationMs} ms</span></li>`;
      })
      .join("");
    const logItems = logs
      .map((log) => `<li class="${log.level === "error" ? "error" : log.level === "warn" ? "warn" : ""}">${escapeHtml(log.level)}: ${escapeHtml(log.message)}${log.data && Object.keys(log.data).length ? ` ${escapeHtml(JSON.stringify(log.data))}` : ""}</li>`)
      .join("");
    effects.innerHTML = `
      <details open><summary>Outbound calls <b>${calls.length}</b> (${calls.filter((call) => call.routed === "upstream").length} upstream, ${calls.filter((call) => call.routed === "stub").length} stubbed)</summary><ul>${callItems || "<li>none</li>"}</ul></details>
      <details ${logs.some((log) => log.level === "error" || log.level === "warn") ? "open" : ""}><summary>Worker logs <b>${logs.length}</b></summary><ul>${logItems || "<li>none</li>"}</ul></details>
      <details><summary>Local D1 · rag_ai_interactions <b>${interaction ? `#${interaction.id} ${interaction.status}` : "no row"}</b> · spend events <b>${spend.length}</b></summary><pre class="json">${highlightJson({ interaction, spendEvents: spend })}</pre></details>`;
    $("effects-meta").textContent = `${result.durationMs} ms total`;
  };

  const renderMentionResult = (result) => {
    lastResult = result;
    learnFromExchanges(result.ai);
    $("payload-title").textContent = "Discord MESSAGE_CREATE";
    setJson($("payload-json"), result.message);
    renderExchanges(result.ai, $("ai-request"), "request");
    renderExchanges(result.ai, $("ai-response"), "response");
    $("ai-request-meta").textContent = result.ai?.length ? `${result.ai.length} call(s)` : "no model call";
    $("ai-response-meta").textContent = result.ai?.length ? `${result.ai.map((exchange) => `${exchange.durationMs} ms`).join(", ")}` : "";

    const parsed = $("parsed-output");
    const reply = result.replies?.[0];
    $("parsed-title").textContent = "Parsed output → Discord";
    const failure = aiFailureSummary(result.ai);
    if (reply) {
      parsed.className = "parsed";
      parsed.innerHTML = `${renderContent(reply.content)}${(result.replies.length > 1 ? `<div class="sub">+${result.replies.length - 1} more message(s) posted</div>` : "")}`;
    } else if (failure) {
      parsed.className = "parsed none error";
      parsed.textContent = `Model call failed, so nothing was posted.\n${failure}`;
    } else {
      parsed.className = "parsed none";
      parsed.textContent = "No message was posted to the channel. Check the worker logs below (not a mention? banned? rate limited? guild not allowed?).";
    }
    const row = result.db?.interaction;
    const usage = row ? `${row.prompt_tokens ?? "?"}/${row.completion_tokens ?? "?"}/${row.total_tokens ?? "?"} tokens` : "";
    $("parsed-meta").textContent = row ? `${row.model} · ${row.status} · ai ${row.ai_duration_ms ?? "?"} ms · ${usage}` : "";
    renderEffects(result);
  };

  const renderInteractionResult = (result) => {
    lastResult = result;
    learnFromExchanges(result.ai);
    $("payload-title").textContent = "Discord interaction (APPLICATION_COMMAND)";
    setJson($("payload-json"), result.interaction);
    renderExchanges(result.ai, $("ai-request"), "request");
    renderExchanges(result.ai, $("ai-response"), "response");
    $("ai-request-meta").textContent = result.ai?.length ? `${result.ai.length} call(s)` : "no model call";
    $("ai-response-meta").textContent = "";

    const parsed = $("parsed-output");
    $("parsed-title").textContent = "Interaction replies → Discord";
    const sections = [];
    for (const edit of result.edits ?? []) {
      sections.push(`<div><div class="sub">edit @original</div>${renderContent(edit.content)}${(edit.attachments ?? []).map(attachmentHtml).join("")}</div>`);
    }
    for (const followUp of result.followUps ?? []) {
      sections.push(`<div><div class="sub">follow-up</div>${renderContent(followUp.content)}${(followUp.attachments ?? []).map(attachmentHtml).join("")}</div>`);
    }
    for (const message of result.channelMessages ?? []) {
      sections.push(`<div><div class="sub">message → channel ${escapeHtml(message.channelId)}</div>${renderContent(message.content)}</div>`);
    }
    for (const thread of result.threadsCreated ?? []) {
      sections.push(`<div class="sub">thread created: ${escapeHtml(thread.name)} (${escapeHtml(thread.id)}) in ${escapeHtml(thread.parentId)}</div>`);
    }
    const failure = aiFailureSummary(result.ai);
    if (failure) {
      sections.push(`<div class="sub error">model call failed: ${escapeHtml(failure)}</div>`);
    }
    parsed.className = sections.length ? "parsed" : "parsed none";
    parsed.innerHTML = sections.length ? sections.join("") : "No reply, follow-up, or channel message was sent.";
    $("parsed-meta").textContent = "";
    renderEffects(result);
  };

  const renderError = (error) => {
    $("parsed-output").className = "parsed none";
    $("parsed-output").textContent = `Error: ${error.message}`;
    $("effects").innerHTML = "—";
  };

  // ---------- sending ----------

  const setBusy = (value) => {
    busy = value;
    $("send").disabled = value;
    $("run-command").disabled = value;
    document.body.style.cursor = value ? "progress" : "";
  };

  const sendMessage = async (content) => {
    if (busy || !content.trim()) {
      return;
    }
    const identity = currentIdentity();
    if (!identity.userId || !identity.username) {
      $("composer-hint").textContent = "Set a user ID and username first.";
      return;
    }
    readOverrides();
    rememberDraft();
    const entries = transcript();
    const priorTranscript = entries.filter((entry) => entry.status !== "pending" && entry.status !== "error");
    const lastBot = [...priorTranscript].reverse().find((entry) => entry.role === "bot");
    const replyToId = $("reply-last").checked && lastBot ? lastBot.id : undefined;
    const mentionBot = $("mention-bot").checked;

    const pendingId = `pending-${Date.now()}`;
    entries.push({ id: pendingId, role: "user", content: mentionBot ? `<@${$("bot-user-id").value.trim()}> ${content}` : content, author: identity, replyToId, at: Date.now(), status: "pending" });
    renderTranscript();
    setBusy(true);
    $("composer-hint").textContent = "Running…";

    try {
      await ensureProdConfig();
      const result = await api("/api/mention", {
        method: "POST",
        body: JSON.stringify({
          content,
          mentionBot,
          identity,
          botUserId: $("bot-user-id").value.trim(),
          guildId: $("guild-id").value.trim(),
          channelId: $("channel-id").value.trim(),
          mode: $("mode").value,
          transcript: priorTranscript.map((entry) => ({ id: entry.id, role: entry.role, content: entry.content, author: entry.author })),
          replyToId,
          overrides: overridesPayload(),
        }),
      });
      const pending = entries.find((entry) => entry.id === pendingId);
      if (pending) {
        pending.id = result.message.id;
        pending.content = result.message.content;
        delete pending.status;
      }
      for (const reply of result.replies ?? []) {
        entries.push({ id: reply.id ?? snowflake(), role: "bot", content: reply.content, at: Date.now() });
      }
      renderMentionResult(result);
      $("composer-hint").textContent = result.replies?.length ? `Reply in ${result.durationMs} ms.` : `No reply (${result.durationMs} ms). See side effects.`;
    } catch (error) {
      const pending = entries.find((entry) => entry.id === pendingId);
      if (pending) {
        pending.status = "error";
        pending.content += `\n⚠ ${error.message}`;
      }
      renderError(error);
      $("composer-hint").textContent = `Error: ${error.message}`;
    } finally {
      setBusy(false);
      renderTranscript();
      saveState();
    }
  };

  // ---------- slash commands ----------

  const renderCommandForm = () => {
    const select = $("command-select");
    const command = meta.commands.find((candidate) => candidate.name === select.value) ?? meta.commands[0];
    if (!command) {
      return;
    }
    select.value = command.name;
    state.slash.command = command.name;
    const flags = [command.adminOnly ? "admin only" : null, command.aiLimited ? "AI limited (ban + usage checks)" : null].filter(Boolean).join(" · ");
    $("command-description").textContent = `${command.description}${flags ? ` — ${flags}` : ""}`;
    const values = state.slash.values[command.name] ?? {};
    $("command-options").innerHTML = (command.options ?? [])
      .map((option) => {
        const value = values[option.name] ?? {};
        if (option.type === 6) {
          return `<label>${escapeHtml(option.name)} (user)${option.required ? " *" : ""}<span class="option-user">
            <input data-option="${escapeHtml(option.name)}" data-field="id" placeholder="user id" value="${escapeHtml(value.id ?? "")}" spellcheck="false">
            <input data-option="${escapeHtml(option.name)}" data-field="username" placeholder="username (resolved)" value="${escapeHtml(value.username ?? "")}" spellcheck="false"></span>
            <span class="hint">${escapeHtml(option.description)}</span></label>`;
        }
        const long = (option.max_length ?? 0) > 200;
        return `<label>${escapeHtml(option.name)}${option.required ? " *" : ""}
          ${long
            ? `<textarea data-option="${escapeHtml(option.name)}" data-field="value" rows="3">${escapeHtml(value.value ?? "")}</textarea>`
            : `<input data-option="${escapeHtml(option.name)}" data-field="value" value="${escapeHtml(value.value ?? "")}">`}
          <span class="hint">${escapeHtml(option.description)}</span></label>`;
      })
      .join("");
    $("slash-hint").textContent = meta.adminUserIds.includes($("user-id").value.trim()) ? "Current user is a rag admin." : command.adminOnly ? "Current user is not a rag admin: this command will be refused." : "";
  };

  const readCommandValues = () => {
    const command = meta.commands.find((candidate) => candidate.name === $("command-select").value);
    const values = {};
    for (const input of $("command-options").querySelectorAll("[data-option]")) {
      const name = input.dataset.option;
      values[name] = values[name] ?? {};
      values[name][input.dataset.field] = input.value;
    }
    state.slash.values[command.name] = values;
    saveState();
    return { command, values };
  };

  const runCommand = async () => {
    if (busy) {
      return;
    }
    const identity = currentIdentity();
    if (!identity.userId || !identity.username) {
      $("slash-hint").textContent = "Set a user ID and username first.";
      return;
    }
    readOverrides();
    rememberDraft();
    const { command, values } = readCommandValues();
    const options = [];
    const resolvedUsers = {};
    for (const option of command.options ?? []) {
      const value = values[option.name] ?? {};
      if (option.type === 6) {
        if (value.id) {
          options.push({ name: option.name, type: 6, value: value.id.trim() });
          resolvedUsers[value.id.trim()] = { userId: value.id.trim(), username: value.username?.trim() || `user_${value.id.trim().slice(-4)}` };
        }
      } else if (value.value) {
        options.push({ name: option.name, type: option.type, value: value.value });
      }
    }
    setBusy(true);
    $("slash-hint").textContent = "Running…";
    try {
      await ensureProdConfig();
      const result = await api("/api/interaction", {
        method: "POST",
        body: JSON.stringify({
          command: command.name,
          options,
          resolvedUsers,
          identity,
          guildId: $("guild-id").value.trim(),
          channelId: $("channel-id").value.trim(),
          overrides: overridesPayload(),
        }),
      });
      renderInteractionResult(result);
      $("slash-hint").textContent = `Done in ${result.durationMs} ms.`;
    } catch (error) {
      renderError(error);
      $("slash-hint").textContent = `Error: ${error.message}`;
    } finally {
      setBusy(false);
    }
  };

  // ---------- replay drawer ----------

  const loadReplay = async () => {
    const list = $("replay-list");
    const hint = $("replay-hint");
    const source = $("replay-source").value;
    hint.className = "hint";
    hint.textContent = "Loading…";
    list.innerHTML = "";
    try {
      const params = new URLSearchParams({ limit: $("replay-limit").value });
      if (source === "production") {
        params.set("kind", $("replay-kind").value);
        if ($("replay-search").value.trim()) {
          params.set("q", $("replay-search").value.trim());
        }
      }
      const { rows } = await api(`/api/${source === "production" ? "prod" : "local"}/interactions?${params}`);
      const filtered = source === "local"
        ? rows.filter((row) => {
          const kinds = $("replay-kind").value ? $("replay-kind").value.split(",") : null;
          const query = $("replay-search").value.trim().toLowerCase();
          return (!kinds || kinds.includes(row.kind)) && (!query || `${row.prompt} ${row.requester_username ?? ""}`.toLowerCase().includes(query));
        })
        : rows;
      hint.textContent = `${filtered.length} row(s) from ${source === "production" ? "production" : "local"} rag_ai_interactions. Replaying sends the stored prompt as a fresh message from the stored user.`;
      list.innerHTML = filtered
        .map((row) => `<div class="replay-row" data-id="${row.id}">
          <div class="meta"><b>#${row.id}</b><span>${escapeHtml(fmtTime(row.created_at))}</span><span>${escapeHtml(row.kind)}</span><b>${escapeHtml(row.requester_username ?? "?")}</b><span>${escapeHtml(row.requester_user_id ?? "")}</span><span>${escapeHtml(row.model ?? "")}</span><span class="${row.status === "ok" ? "" : "status-error"}">${escapeHtml(row.status ?? "")}${row.error_message ? `: ${escapeHtml(row.error_message)}` : ""}</span></div>
          <div class="actions"><button class="ghost small" data-action="load">load</button><button class="ghost small" data-action="send">load &amp; send</button></div>
          <div class="prompt">${escapeHtml(row.prompt ?? "")}</div>
          ${row.response_text ? `<div class="response">↳ ${escapeHtml(row.response_text)}</div>` : ""}
        </div>`)
        .join("");
      list.dataset.rows = JSON.stringify(filtered);
    } catch (error) {
      hint.className = "hint error";
      hint.textContent = error.message;
    }
  };

  const applyReplayRow = (row) => {
    applyProfile({
      name: `prod: ${row.requester_username ?? row.requester_user_id ?? "user"}`,
      userId: row.requester_user_id ?? "",
      username: row.requester_username ?? "user",
      globalName: "",
      nick: row.requester_username ?? "",
    });
    state.activeProfile = null;
    renderProfiles();
    rememberDraft();
    $("mode").value = row.kind === "thread_reply" ? "thread" : "channel";
    state.mode = $("mode").value;
    composerHint();
    $("composer-input").value = row.prompt ?? "";
    switchPage("mention");
    $("composer-input").focus();
  };

  // ---------- pages ----------

  const switchPage = (page) => {
    state.page = page;
    saveState();
    for (const tab of document.querySelectorAll(".tab")) {
      tab.classList.toggle("active", tab.dataset.page === page);
    }
    $("chat-card").classList.toggle("hidden", page !== "mention");
    $("slash-card").classList.toggle("hidden", page !== "slash");
    applyLayout();
    if (page === "slash" && meta) {
      renderCommandForm();
    }
  };

  const newChannel = () => {
    $("channel-id").value = snowflake();
    state.ids.channelId = $("channel-id").value;
    saveState();
    renderTranscript();
  };

  // ---------- wiring ----------

  const wire = () => {
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => switchPage(tab.dataset.page));
    }

    $("profile-select").addEventListener("change", () => {
      state.activeProfile = $("profile-select").value || null;
      const profile = state.profiles.find((candidate) => candidate.name === state.activeProfile);
      if (profile) {
        applyProfile(profile);
      }
      rememberDraft();
      if (state.page === "slash") {
        renderCommandForm();
      }
    });
    $("profile-save").addEventListener("click", saveProfile);
    $("profile-delete").addEventListener("click", deleteProfile);
    for (const id of identityInputs) {
      $(id).addEventListener("input", rememberDraft);
    }

    for (const id of ["bot-user-id", "guild-id", "channel-id"]) {
      $(id).addEventListener("input", () => {
        state.ids = { botUserId: $("bot-user-id").value.trim(), guildId: $("guild-id").value.trim(), channelId: $("channel-id").value.trim() };
        saveState();
        if (id === "channel-id") {
          renderTranscript();
        }
      });
    }
    $("new-channel").addEventListener("click", newChannel);
    $("mode").addEventListener("change", () => {
      state.mode = $("mode").value;
      saveState();
      composerHint();
    });
    $("mention-bot").addEventListener("change", () => {
      state.mentionBot = $("mention-bot").checked;
      saveState();
    });
    $("reply-last").addEventListener("change", () => {
      state.replyLast = $("reply-last").checked;
      saveState();
    });

    for (const id of ["model", "temperature", "max-tokens", "history-limit", "web-search-model"]) {
      $(id).addEventListener("input", () => {
        readOverrides();
        renderModelCost();
      });
    }
    $("config-source").addEventListener("change", async () => {
      readOverrides();
      if (state.configSource === "production") {
        try {
          prodKv = null;
          await ensureProdConfig();
          $("composer-hint").textContent = `Production KV config loaded (${prodKv.keys.length} keys).`;
        } catch (error) {
          $("composer-hint").textContent = `Could not load production config: ${error.message}`;
          $("config-source").value = "bundled";
          readOverrides();
        }
      }
    });
    $("provider-filter").addEventListener("change", () => {
      readOverrides();
      renderModelList();
    });
    $("chat-only").addEventListener("change", () => {
      readOverrides();
      renderModelList();
    });
    $("show-key-required").addEventListener("change", () => {
      readOverrides();
      renderModelList();
    });
    $("probe-model").addEventListener("click", probeModelId);
    $("refresh-models").addEventListener("click", () => loadModels(true));
    $("reset-overrides").addEventListener("click", () => {
      state.overrides = { model: "", temperature: "", maxTokens: "", historyLimit: "", webSearchModel: "" };
      saveState();
      applyOverridesToInputs();
    });
    $("show-config").addEventListener("click", showResolvedConfig);
    $("config-close").addEventListener("click", () => $("config-dialog").close());
    $("reset-layout").addEventListener("click", resetLayout);
    $("layout").addEventListener("pointerdown", startDrag);
    $("layout").addEventListener("dblclick", (event) => {
      // Double-click a gutter to reset just that pair to the defaults.
      const gutter = event.target.closest(".gutter");
      if (!gutter) {
        return;
      }
      const layout = layoutState();
      const defaults = DEFAULT_LAYOUT();
      if (gutter.classList.contains("v")) {
        layout.cols[gutter.dataset.before] = defaults.cols[gutter.dataset.before];
        layout.cols[gutter.dataset.after] = defaults.cols[gutter.dataset.after];
      } else {
        layout.rows[gutter.dataset.before] = defaults.rows[gutter.dataset.before] ?? 1;
        layout.rows[gutter.dataset.after] = defaults.rows[gutter.dataset.after] ?? 1;
      }
      saveState();
      applyLayout();
    });

    $("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const content = $("composer-input").value;
      $("composer-input").value = "";
      sendMessage(content);
    });
    $("composer-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        $("composer").requestSubmit();
      }
    });
    $("clear-transcript").addEventListener("click", () => {
      state.transcripts[$("channel-id").value.trim()] = [];
      saveState();
      renderTranscript();
    });
    $("reset-limits").addEventListener("click", async () => {
      try {
        const { deleted } = await api("/api/local/reset-limits", { method: "POST", body: "{}" });
        $("composer-hint").textContent = `Cleared ${deleted} local rate-limit row(s).`;
      } catch (error) {
        $("composer-hint").textContent = error.message;
      }
    });

    $("command-select").addEventListener("change", renderCommandForm);
    $("run-command").addEventListener("click", runCommand);

    $("toggle-drawer").addEventListener("click", () => {
      $("drawer").classList.toggle("hidden");
      if (!$("drawer").classList.contains("hidden")) {
        loadReplay();
      }
    });
    $("drawer-close").addEventListener("click", () => $("drawer").classList.add("hidden"));
    $("replay-refresh").addEventListener("click", loadReplay);
    $("replay-source").addEventListener("change", loadReplay);
    $("replay-kind").addEventListener("change", loadReplay);
    $("replay-search").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        loadReplay();
      }
    });
    $("replay-list").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }
      const rowElement = button.closest(".replay-row");
      const rows = JSON.parse($("replay-list").dataset.rows ?? "[]");
      const row = rows.find((candidate) => String(candidate.id) === rowElement.dataset.id);
      if (!row) {
        return;
      }
      applyReplayRow(row);
      $("drawer").classList.add("hidden");
      if (button.dataset.action === "send") {
        const content = $("composer-input").value;
        $("composer-input").value = "";
        sendMessage(content);
      }
    });
  };

  // ---------- boot ----------

  const boot = async () => {
    wire();
    applyLayout();
    try {
      meta = await api("/api/meta");
    } catch (error) {
      $("composer-hint").className = "hint error";
      $("composer-hint").textContent = `Could not load /api/meta: ${error.message}`;
      return;
    }

    // Stored ids must be snowflakes; anything else (e.g. an unresolved op://
    // reference captured from an earlier run) is replaced by the worker's value.
    const isSnowflake = (value) => /^\d{17,20}$/.test(value ?? "");
    $("bot-user-id").value = isSnowflake(state.ids.botUserId) ? state.ids.botUserId : meta.applicationId;
    $("guild-id").value = isSnowflake(state.ids.guildId) ? state.ids.guildId : meta.guildId;
    $("channel-id").value = isSnowflake(state.ids.channelId) ? state.ids.channelId : snowflake();
    state.ids = { botUserId: $("bot-user-id").value, guildId: $("guild-id").value, channelId: $("channel-id").value };
    $("mode").value = state.mode;
    $("mention-bot").checked = state.mentionBot;
    $("reply-last").checked = state.replyLast;

    renderProfiles();
    const active = state.profiles.find((profile) => profile.name === state.activeProfile);
    applyProfile(active ?? state.draft ?? null);

    $("command-select").innerHTML = meta.commands.map((command) => `<option value="${escapeHtml(command.name)}">/${escapeHtml(command.name)}</option>`).join("");
    if (state.slash.command) {
      $("command-select").value = state.slash.command;
    }

    applyOverridesToInputs();
    composerHint();
    renderTranscript();
    renderPills();
    switchPage(state.page);
    await loadModels();
    if (state.configSource === "production") {
      ensureProdConfig().catch((error) => {
        $("composer-hint").textContent = `Production config unavailable (${error.message}); using bundled.`;
        state.configSource = "bundled";
        $("config-source").value = "bundled";
        saveState();
      });
    }
  };

  boot();
})();
