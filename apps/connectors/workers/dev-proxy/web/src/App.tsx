import {
  Cable,
  CheckCircle2,
  Code2,
  GitBranch,
  KeyRound,
  LogOut,
  Play,
  RefreshCw,
  Send,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

type Section = "commands" | "connectors" | "github" | "api";

type ConnectorSummary = {
  id: string;
  kind: string;
  host: string;
  secretConfigured: boolean;
  secretProvider: string;
  flows?: string[];
};

type SecretProvider = {
  name: string;
  writable: boolean;
  configured: boolean;
};

type EndpointPreset = {
  key: string;
  label: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: string;
};

type ApiResult = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

type GithubPreset = {
  key: string;
  method: string;
  path: string;
  label: string;
  tag: string;
  route: string;
  params: Record<string, string | number | boolean>;
};

const endpoints: EndpointPreset[] = [
  { key: "connectors", label: "List connectors", method: "GET", path: "/api/connectors", body: "" },
  { key: "providers", label: "List secrets providers", method: "GET", path: "/api/secrets/providers", body: "" },
  { key: "github", label: "GitHub App installations", method: "GET", path: "/api/connectors/github-app/installations", body: "" },
  {
    key: "github-api",
    label: "Call GitHub API",
    method: "POST",
    path: "/api/github",
    body: '{\n  "installationId": "144201662",\n  "method": "GET",\n  "path": "/installation/repositories?per_page=5"\n}',
  },
  { key: "command", label: "Run command", method: "POST", path: "/api/command", body: '{\n  "command": "ragboard",\n  "options": []\n}' },
  {
    key: "secret",
    label: "Set connector secret",
    method: "PUT",
    path: "/api/connectors/github-app/secret",
    body: '{\n  "provider": "wrangler-env",\n  "ref": "GITHUB_APP_PRIVATE_KEY"\n}',
  },
];

const fallbackGithubRoutes: GithubPreset[] = [
  {
    key: "installation-repos",
    method: "GET",
    path: "/installation/repositories",
    label: "Installation repositories",
    tag: "apps",
    route: "GET /installation/repositories",
    params: { per_page: 10 },
  },
  {
    key: "repo",
    method: "GET",
    path: "/repos/{owner}/{repo}",
    label: "Repository",
    tag: "repos",
    route: "GET /repos/{owner}/{repo}",
    params: { owner: "jsmunro", repo: "rag" },
  },
  {
    key: "issues",
    method: "GET",
    path: "/repos/{owner}/{repo}/issues",
    label: "Issues",
    tag: "issues",
    route: "GET /repos/{owner}/{repo}/issues",
    params: { owner: "jsmunro", repo: "rag", state: "open", per_page: 10 },
  },
  {
    key: "pulls",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    label: "Pull requests",
    tag: "pulls",
    route: "GET /repos/{owner}/{repo}/pulls",
    params: { owner: "jsmunro", repo: "rag", state: "open", per_page: 10 },
  },
  {
    key: "contents",
    method: "GET",
    path: "/repos/{owner}/{repo}/contents/{path}",
    label: "File contents",
    tag: "repos",
    route: "GET /repos/{owner}/{repo}/contents/{path}",
    params: { owner: "jsmunro", repo: "rag", path: "README.md" },
  },
  {
    key: "workflow-runs",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/runs",
    label: "Workflow runs",
    tag: "actions",
    route: "GET /repos/{owner}/{repo}/actions/runs",
    params: { owner: "jsmunro", repo: "rag", per_page: 10 },
  },
];

const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

const readBody = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (!text) {
    return "";
  }
  try {
    return formatJson(JSON.parse(text));
  } catch {
    return text;
  }
};

const parseMaybeJson = (value: string): unknown => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const missingGithubRouteParams = (route: string, params: Record<string, unknown>): string[] => {
  const missing: string[] = [];
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1].replace(/^\+/, "");
    if (params[name] === undefined || params[name] === "") {
      missing.push(name);
    }
  }
  return missing;
};

const apiRequest = async (method: string, path: string, body: string): Promise<ApiResult> => {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: {},
  };
  if (method !== "GET" && body.trim().length > 0) {
    JSON.parse(body);
    init.body = body;
    init.headers = { "content-type": "application/json" };
  }
  const response = await fetch(path, init);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: await readBody(response),
  };
};

export function App() {
  const [section, setSection] = useState<Section>(() => {
    if (window.location.pathname === "/apis") {
      return "api";
    }
    if (window.location.pathname === "/github") {
      return "github";
    }
    return "commands";
  });
  const [sessionStatus, setSessionStatus] = useState("Checking session...");
  const [signedIn, setSignedIn] = useState(false);
  const [who, setWho] = useState("");

  const [command, setCommand] = useState("ragboard");
  const [channelId, setChannelId] = useState("");
  const [options, setOptions] = useState("[]");
  const [commandResult, setCommandResult] = useState("-");

  const [providers, setProviders] = useState<SecretProvider[]>([]);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [connectorStatus, setConnectorStatus] = useState("Loading connectors...");

  const [selectedEndpoint, setSelectedEndpoint] = useState(endpoints[0].key);
  const preset = useMemo(() => endpoints.find((endpoint) => endpoint.key === selectedEndpoint) ?? endpoints[0], [selectedEndpoint]);
  const [apiMethod, setApiMethod] = useState<EndpointPreset["method"]>(preset.method);
  const [apiPath, setApiPath] = useState(preset.path);
  const [apiBody, setApiBody] = useState(preset.body);
  const [apiOut, setApiOut] = useState("-");
  const [busyApi, setBusyApi] = useState(false);
  const [githubRoutes, setGithubRoutes] = useState<GithubPreset[]>(fallbackGithubRoutes);
  const [githubRoutesStatus, setGithubRoutesStatus] = useState("Loading GitHub routes...");
  const [githubRouteQuery, setGithubRouteQuery] = useState("");
  const [selectedGithubPreset, setSelectedGithubPreset] = useState(fallbackGithubRoutes[0].key);
  const [githubInstallationId, setGithubInstallationId] = useState("144201662");
  const [githubRoute, setGithubRoute] = useState(fallbackGithubRoutes[0].route);
  const [githubParams, setGithubParams] = useState(formatJson(fallbackGithubRoutes[0].params));
  const [githubBody, setGithubBody] = useState("");
  const [githubOut, setGithubOut] = useState("-");
  const [busyGithub, setBusyGithub] = useState(false);

  const showSection = (next: Section) => {
    setSection(next);
    const path = next === "api" ? "/apis" : next === "github" ? "/github" : "/";
    window.history.replaceState(null, "", path);
  };

  const loadSession = async () => {
    try {
      const response = await fetch("/api/auth/get-session", { credentials: "include" });
      const data = response.ok ? await response.json() : null;
      if (data?.user) {
        setWho(data.user.name || data.user.email || data.user.id);
        setSignedIn(true);
        setSessionStatus("");
        void loadConnectors();
        return;
      }
    } catch {
      // Fall through to signed-out state.
    }
    setSignedIn(false);
    setSessionStatus("Not signed in.");
  };

  const signIn = async () => {
    setSessionStatus("Redirecting to Discord...");
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "discord", callbackURL: window.location.pathname === "/apis" || window.location.pathname === "/github" ? window.location.pathname : "/" }),
        credentials: "include",
      });
      const data = await response.json();
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      setSessionStatus("Could not start Discord sign-in.");
    } catch (error) {
      setSessionStatus(`Sign-in request failed: ${String(error)}`);
    }
  };

  const signOut = async () => {
    try {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
    } finally {
      await loadSession();
    }
  };

  const runCommand = async () => {
    setCommandResult("Running...");
    let parsedOptions: unknown;
    try {
      parsedOptions = JSON.parse(options || "[]");
    } catch {
      setCommandResult("Options must be valid JSON.");
      return;
    }
    const payload: Record<string, unknown> = { command: command.trim(), options: parsedOptions };
    if (channelId.trim()) {
      payload.channelId = channelId.trim();
    }
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      const body = await readBody(response);
      if (response.status === 401) {
        setCommandResult("HTTP 401 - session invalid or expired.");
        await loadSession();
        return;
      }
      setCommandResult(`HTTP ${response.status}\n\n${body}`);
    } catch (error) {
      setCommandResult(`Request failed: ${String(error)}`);
    }
  };

  const loadProviders = async (): Promise<SecretProvider[]> => {
    try {
      const response = await fetch("/api/secrets/providers", { credentials: "include" });
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      return data?.providers ?? [];
    } catch {
      return [];
    }
  };

  const loadConnectors = async () => {
    setConnectorStatus("Loading connectors...");
    setConnectors([]);
    const loadedProviders = await loadProviders();
    setProviders(loadedProviders);
    try {
      const response = await fetch("/api/connectors", { credentials: "include" });
      if (!response.ok) {
        setConnectorStatus(`Could not load connectors. HTTP ${response.status}.`);
        return;
      }
      const data = await response.json();
      const loaded = data?.connectors ?? [];
      setConnectors(loaded);
      setConnectorStatus(loaded.length ? "" : "No connectors configured.");
    } catch (error) {
      setConnectorStatus(`Failed to load connectors: ${String(error)}`);
    }
  };

  const applyPreset = (endpoint: EndpointPreset) => {
    setSelectedEndpoint(endpoint.key);
    setApiMethod(endpoint.method);
    setApiPath(endpoint.path);
    setApiBody(endpoint.body);
  };

  const applyGithubPreset = (preset: GithubPreset) => {
    setSelectedGithubPreset(preset.key);
    setGithubRoute(preset.route);
    setGithubParams(formatJson(preset.params));
    setGithubBody("");
  };

  const filteredGithubRoutes = useMemo(() => {
    const terms = githubRouteQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const matched = terms.length
      ? githubRoutes.filter((route) => {
          const haystack = `${route.method} ${route.path} ${route.label} ${route.tag}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
      : githubRoutes;
    return matched.slice(0, 80);
  }, [githubRouteQuery, githubRoutes]);

  const loadGithubRoutes = async () => {
    setGithubRoutesStatus("Loading GitHub routes...");
    try {
      const response = await fetch("/api/github/routes", { credentials: "include" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data?.routes)) {
        setGithubRoutesStatus(`Using fallback routes. HTTP ${response.status}.`);
        return;
      }
      setGithubRoutes(data.routes);
      setGithubRoutesStatus(`${data.routes.length} GitHub routes loaded.`);
    } catch (error) {
      setGithubRoutesStatus(`Using fallback routes. ${String(error)}`);
    }
  };

  const sendApi = async () => {
    setBusyApi(true);
    setApiOut("Sending...");
    try {
      const result = await apiRequest(apiMethod, apiPath, apiBody);
      setApiOut(
        formatJson({
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          body: parseMaybeJson(result.body),
        }),
      );
    } catch (error) {
      setApiOut(`Request failed: ${String(error)}`);
    } finally {
      setBusyApi(false);
    }
  };

  const sendGithub = async () => {
    setBusyGithub(true);
    setGithubOut("Sending...");
    try {
      const payload: Record<string, unknown> = {
        installationId: githubInstallationId.trim(),
        route: githubRoute.trim(),
      };
      let params: Record<string, unknown> = {};
      if (githubParams.trim()) {
        params = JSON.parse(githubParams);
        payload.params = params;
      }
      const missing = missingGithubRouteParams(githubRoute.trim(), params);
      if (missing.length > 0) {
        setGithubOut(`Missing route params: ${missing.join(", ")}`);
        return;
      }
      if (githubBody.trim()) {
        payload.body = githubBody;
      }
      const response = await fetch("/api/github", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readBody(response);
      setGithubOut(`HTTP ${response.status}\n\n${body}`);
    } catch (error) {
      setGithubOut(`Request failed: ${String(error)}`);
    } finally {
      setBusyGithub(false);
    }
  };

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (signedIn) {
      void loadGithubRoutes();
    }
  }, [signedIn]);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>ragbot admin</h1>
          <p>Production command and connector control plane</p>
        </div>
        {signedIn ? (
          <div className="identity">
            <span>{who}</span>
            <button type="button" className="iconButton" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut size={18} />
            </button>
          </div>
        ) : null}
      </header>

      {!signedIn ? (
        <section className="authPanel">
          <p>{sessionStatus}</p>
          <button type="button" className="primaryButton" onClick={signIn}>
            Sign in with Discord
          </button>
        </section>
      ) : (
        <div className="layout">
          <nav className="sideNav" aria-label="Admin sections">
            <NavButton active={section === "commands"} icon={<TerminalSquare size={18} />} label="Commands" onClick={() => showSection("commands")} />
            <NavButton active={section === "connectors"} icon={<Cable size={18} />} label="Connectors" onClick={() => showSection("connectors")} />
            <NavButton active={section === "github"} icon={<GitBranch size={18} />} label="GitHub APIs" onClick={() => showSection("github")} />
            <NavButton active={section === "api"} icon={<Code2 size={18} />} label="API workbench" onClick={() => showSection("api")} />
          </nav>

          <main>
            {section === "commands" ? (
              <section className="surface">
                <div className="sectionHeader">
                  <h2>Commands</h2>
                  <button type="button" className="primaryButton compact" onClick={runCommand}>
                    <Play size={16} />
                    Run
                  </button>
                </div>
                <div className="formGrid">
                  <label>
                    Command
                    <input value={command} onChange={(event) => setCommand(event.target.value)} />
                  </label>
                  <label>
                    Channel id
                    <input value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="optional snowflake" />
                  </label>
                </div>
                <label>
                  Options
                  <textarea rows={5} value={options} onChange={(event) => setOptions(event.target.value)} />
                </label>
                <Output value={commandResult} />
              </section>
            ) : null}

            {section === "connectors" ? (
              <section className="surface">
                <div className="sectionHeader">
                  <h2>Connectors</h2>
                  <button type="button" className="secondaryButton compact" onClick={loadConnectors}>
                    <RefreshCw size={16} />
                    Refresh
                  </button>
                </div>
                {connectorStatus ? <p className="statusText">{connectorStatus}</p> : null}
                <div className="connectorList">
                  {connectors.map((connector) => (
                    <ConnectorCard key={connector.id} connector={connector} providers={providers} onChanged={loadConnectors} />
                  ))}
                </div>
              </section>
            ) : null}

            {section === "github" ? (
              <section className="surface">
                <div className="sectionHeader">
                  <div>
                    <h2>GitHub APIs</h2>
                    <p className="sectionHint">Octokit-style routes through the GitHub App connector. {githubRoutesStatus}</p>
                  </div>
                  <button type="button" className="primaryButton compact" onClick={sendGithub} disabled={busyGithub}>
                    <Send size={16} />
                    Call
                  </button>
                </div>
                <div className="apiGrid">
                  <div className="endpointList">
                    <div className="endpointSearch">
                      <input value={githubRouteQuery} onChange={(event) => setGithubRouteQuery(event.target.value)} placeholder="Search GitHub APIs" />
                    </div>
                    {filteredGithubRoutes.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        className={selectedGithubPreset === preset.key ? "selected" : ""}
                        onClick={() => applyGithubPreset(preset)}
                      >
                        <span className="method">{preset.method}</span>
                        <span>{preset.label}</span>
                        <code>{preset.route}</code>
                      </button>
                    ))}
                  </div>
                  <div className="requestPane">
                    <label>
                      Installation id
                      <input value={githubInstallationId} onChange={(event) => setGithubInstallationId(event.target.value)} />
                    </label>
                    <label>
                      Octokit route
                      <input value={githubRoute} onChange={(event) => setGithubRoute(event.target.value)} placeholder="GET /repos/{owner}/{repo}/issues" />
                    </label>
                    <label>
                      Params
                      <textarea rows={8} value={githubParams} onChange={(event) => setGithubParams(event.target.value)} />
                    </label>
                    <label>
                      Body
                      <textarea rows={5} value={githubBody} onChange={(event) => setGithubBody(event.target.value)} />
                    </label>
                    <Output value={githubOut} />
                  </div>
                </div>
              </section>
            ) : null}

            {section === "api" ? (
              <section className="surface">
                <div className="sectionHeader">
                  <h2>API workbench</h2>
                  <button type="button" className="primaryButton compact" onClick={sendApi} disabled={busyApi}>
                    <Send size={16} />
                    Send
                  </button>
                </div>
                <div className="apiGrid">
                  <div className="endpointList">
                    {endpoints.map((endpoint) => (
                      <button
                        key={endpoint.key}
                        type="button"
                        className={selectedEndpoint === endpoint.key ? "selected" : ""}
                        onClick={() => applyPreset(endpoint)}
                      >
                        <span className="method">{endpoint.method}</span>
                        <span>{endpoint.label}</span>
                        <code>{endpoint.path}</code>
                      </button>
                    ))}
                  </div>
                  <div className="requestPane">
                    <div className="requestLine">
                      <select value={apiMethod} onChange={(event) => setApiMethod(event.target.value as EndpointPreset["method"])}>
                        <option>GET</option>
                        <option>POST</option>
                        <option>PUT</option>
                      </select>
                      <input value={apiPath} onChange={(event) => setApiPath(event.target.value)} />
                    </div>
                    <label>
                      Body
                      <textarea rows={10} value={apiBody} onChange={(event) => setApiBody(event.target.value)} />
                    </label>
                    <Output value={apiOut} />
                  </div>
                </div>
              </section>
            ) : null}
          </main>
        </div>
      )}
    </div>
  );
}

function NavButton(props: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" className={props.active ? "active" : ""} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function Output(props: { value: string }) {
  return <pre className="output">{props.value}</pre>;
}

function ConnectorCard(props: { connector: ConnectorSummary; providers: SecretProvider[]; onChanged: () => void }) {
  const { connector, providers, onChanged } = props;
  const [provider, setProvider] = useState(connector.secretProvider);
  const [ref, setRef] = useState("");
  const [value, setValue] = useState("");
  const [result, setResult] = useState("");
  const [variant, setVariant] = useState<"neutral" | "ok" | "warn" | "err">("neutral");
  const [installations, setInstallations] = useState<string[]>([]);
  const [loadingInstallations, setLoadingInstallations] = useState(false);

  const selectedProvider = providers.find((candidate) => candidate.name === provider);
  const canWriteValue = Boolean(selectedProvider?.writable);

  const saveSecret = async () => {
    setResult("Saving...");
    setVariant("neutral");
    const body: Record<string, string> = { provider };
    if (ref.trim()) {
      body.ref = ref.trim();
    }
    if (canWriteValue && value) {
      body.value = value;
    }
    if (!body.ref && !body.value) {
      setResult("Enter a reference or a value.");
      setVariant("err");
      return;
    }
    if (body.value && !body.ref) {
      setResult("A value needs a reference.");
      setVariant("err");
      return;
    }
    try {
      const response = await fetch(`/api/connectors/${encodeURIComponent(connector.id)}/secret`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      setValue("");
      const data = await response.json().catch(() => null);
      const secret = data?.secret;
      if (secret) {
        const nextVariant = secret.status === "written" || secret.status === "referenced" ? "ok" : secret.status === "provision_required" ? "warn" : "err";
        setVariant(nextVariant);
        setResult(`${secret.status}${secret.detail ? ` - ${secret.detail}` : ""}`);
        void onChanged();
      } else {
        setVariant("err");
        setResult(`HTTP ${response.status}${data?.error ? ` - ${data.error}` : ""}`);
      }
    } catch (error) {
      setVariant("err");
      setResult(`Request failed: ${String(error)}`);
    }
  };

  const loadInstallations = async () => {
    setLoadingInstallations(true);
    setInstallations([]);
    try {
      const response = await fetch(`/api/connectors/${encodeURIComponent(connector.id)}/installations`, { credentials: "include" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setInstallations([`HTTP ${response.status}${data?.error ? ` - ${data.error}` : ""}`]);
        return;
      }
      const loaded = data?.installations ?? [];
      setInstallations(
        loaded.length
          ? loaded.map((installation: { id: number; accountLogin: string; repositorySelection: string }) =>
              `#${installation.id} ${installation.accountLogin} (${installation.repositorySelection})`,
            )
          : ["No installations."],
      );
    } finally {
      setLoadingInstallations(false);
    }
  };

  return (
    <article className="connectorCard">
      <div className="connectorTop">
        <div>
          <h3>{connector.id}</h3>
          <p>
            {connector.kind} / {connector.host}
          </p>
        </div>
        <span className={connector.secretConfigured ? "pill ok" : "pill err"}>
          {connector.secretConfigured ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {connector.secretConfigured ? "Secret configured" : "No secret"}
        </span>
      </div>

      <div className="connectorActions">
        {connector.kind === "github_app" ? (
          <button type="button" className="secondaryButton compact" onClick={loadInstallations} disabled={loadingInstallations}>
            <Cable size={16} />
            Installations
          </button>
        ) : null}
      </div>
      {installations.length ? (
        <ul className="plainList">
          {installations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}

      <div className="formGrid">
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            {providers.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
                {candidate.writable ? "" : " (read-only)"}
                {candidate.configured ? "" : " (unconfigured)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reference
          <input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="GITHUB_APP_PRIVATE_KEY" />
        </label>
      </div>
      <label>
        Value
        <input
          type="password"
          value={value}
          disabled={!canWriteValue}
          onChange={(event) => setValue(event.target.value)}
          placeholder={canWriteValue ? "write-only" : "not writable at runtime"}
        />
      </label>
      <button type="button" className="secondaryButton compact" onClick={saveSecret}>
        <KeyRound size={16} />
        Save secret
      </button>
      {result ? <p className={`result ${variant}`}>{result}</p> : null}
    </article>
  );
}
