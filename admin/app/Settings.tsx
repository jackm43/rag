import { useState } from "react";
import { pageDraft } from "./App.tsx";
import { api, targetName, type Catalog, type Draft, type Saved, type Target } from "./api.ts";

const IMAGE_PARAMETERS = [
  ["aspect_ratio", "Aspect ratio"],
  ["quality", "Quality"],
  ["resolution", "Resolution"],
] as const;

type Change = { setting: string; before: unknown; after: unknown };
type Review = { changes: Change[]; reviewId: string; body: object };

type Props = {
  page: string;
  target: Target;
  saved: Saved | null;
  draft: Draft | null;
  dirty: boolean;
  catalog: Catalog | null;
  catalogError?: string;
  settingsError?: string;
  busy: boolean;
  run: (task: () => Promise<string | void>) => Promise<void>;
  onTarget: (target: Target) => void;
  onReload: () => void;
  onRefreshModels: () => void;
  onDraft: (draft: Draft) => void;
  onSaved: (saved: Saved) => void;
};

function ModelSelect({ value, models, savedValue, disabled, onChange }: {
  value: string;
  models: { id: string; name: string; provider: string }[] | undefined;
  savedValue: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const providers = new Map<string, { id: string; name: string }[]>();
  for (const model of [...(models ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    providers.set(model.provider || "Other", [...(providers.get(model.provider || "Other") ?? []), model]);
  }
  const listed = models?.some((model) => model.id === value);
  return (
    <select value={value} disabled={disabled || !models} onChange={(event) => onChange(event.target.value)}>
      {!listed && (
        <option value={value}>
          {value}
          {models ? " (not available on Cloudflare credits)" : ""}
        </option>
      )}
      {[...providers].map(([provider, entries]) => (
        <optgroup key={provider} label={provider}>
          {entries.map((model) => (
            <option key={model.id} value={model.id} title={model.id}>
              {model.name}
              {model.id === savedValue ? " · saved" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

const show = (value: unknown) => (value === null || value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value));

export function SettingsPanel(props: Props) {
  const { page, target, saved, draft, dirty, catalog, busy } = props;
  const [review, setReview] = useState<Review>();
  const edit = (change: (next: Draft) => void) => {
    const next = structuredClone(draft!);
    change(next);
    setReview(undefined);
    props.onDraft(next);
  };

  const header = (
    <div className="card-header">
      <h2>Settings</h2>
      <div className="segmented" role="radiogroup" aria-label="Settings to edit">
        {(["live", "sandbox"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={target === option}
            disabled={busy}
            onClick={() => option !== target && props.onTarget(option)}
          >
            {targetName(option)}
          </button>
        ))}
      </div>
    </div>
  );

  if (!saved || !draft) {
    return (
      <section className="card">
        {header}
        <p className={props.settingsError ? "error" : "muted"}>{props.settingsError ?? "Loading settings…"}</p>
        {props.settingsError && (
          <button type="button" className="secondary" disabled={busy} onClick={props.onReload}>
            Retry
          </button>
        )}
      </section>
    );
  }

  const settings = saved.settings;
  const chatModel = catalog?.chat.find((model) => model.id === draft.chat.model);
  const range = chatModel?.temperature;
  const profileName = draft.image.activeProfile;
  const profile = draft.image.profiles[profileName];
  const imageModel = catalog?.image.find((model) => model.id === profile.model);

  const startReview = () =>
    props.run(async () => {
      const body = { target: saved.target, baseRevision: saved.revision, page, settings: pageDraft(saved, draft, page) };
      const result = await api<{ changes: Change[]; reviewId: string }>("settings/review", body);
      setReview({ ...result, body });
      return result.changes.length ? "Review the changes, then save." : "There are no changes to save.";
    });
  const save = () =>
    props.run(async () => {
      const next = await api<Saved>("settings/save", { ...review!.body, reviewId: review!.reviewId });
      setReview(undefined);
      props.onSaved(next);
      return `Saved to ${targetName(next.target).toLowerCase()}. New requests use these settings now.`;
    });

  return (
    <section className="card">
      {header}
      <p className="muted small">
        {target === "live" ? "Changes apply to the live bot only after review and save." : "Sandbox settings never reach the live bot."}
        {settings.updatedAt && ` Last saved ${new Date(settings.updatedAt).toLocaleString()}.`}
      </p>

      {page === "chat" ? (
        <div className="fields">
          <label className="wide">
            Chat model
            <ModelSelect
              value={draft.chat.model}
              models={catalog?.chat}
              savedValue={settings.chat.model}
              disabled={busy}
              onChange={(id) =>
                edit((next) => {
                  next.chat.model = id;
                })
              }
            />
          </label>
          <label className="wide">
            <span className="label-row">
              Temperature <output>{range || !catalog ? draft.chat.temperature : "not supported by this model"}</output>
            </span>
            <input
              type="range"
              min={range?.minimum ?? 0}
              max={range?.maximum ?? 2}
              step={0.1}
              value={draft.chat.temperature}
              disabled={busy || !range}
              onChange={(event) =>
                edit((next) => {
                  next.chat.temperature = Number(event.target.value);
                })
              }
            />
          </label>
          <label>
            History messages
            <input
              type="number"
              min={1}
              max={12}
              step={1}
              value={draft.chat.historyLimit}
              disabled={busy}
              onChange={(event) =>
                edit((next) => {
                  next.chat.historyLimit = Number(event.target.value);
                })
              }
            />
          </label>
          <label className="wide">
            <span className="label-row">
              System prompt
              {draft.chat.prompt !== settings.chat.prompt && (
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    edit((next) => {
                      next.chat.prompt = settings.chat.prompt;
                    })
                  }
                >
                  Restore saved
                </button>
              )}
            </span>
            <textarea
              rows={8}
              value={draft.chat.prompt}
              disabled={busy}
              onChange={(event) =>
                edit((next) => {
                  next.chat.prompt = event.target.value;
                })
              }
            />
          </label>
        </div>
      ) : (
        <div className="fields">
          <label>
            Image profile
            <select
              value={profileName}
              disabled={busy}
              onChange={(event) =>
                edit((next) => {
                  next.image.activeProfile = event.target.value;
                })
              }
            >
              {Object.keys(draft.image.profiles).map((name) => (
                <option key={name} value={name}>
                  {name}
                  {name === settings.image.activeProfile ? " · saved" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Image model
            <ModelSelect
              value={profile.model}
              models={catalog?.image}
              savedValue={settings.image.profiles[profileName]?.model ?? ""}
              disabled={busy}
              onChange={(id) =>
                edit((next) => {
                  next.image.profiles[profileName].model = id;
                })
              }
            />
          </label>
          {IMAGE_PARAMETERS.map(([field, label]) => {
            const spec = imageModel?.parameters[field];
            if (!spec?.enum) return null;
            const value = spec.enum.includes(profile.parameters[field]) ? profile.parameters[field] : (spec.default ?? "");
            return (
              <label key={field}>
                {label}
                <select
                  value={value}
                  disabled={busy}
                  onChange={(event) =>
                    edit((next) => {
                      next.image.profiles[profileName].parameters[field] = event.target.value;
                    })
                  }
                >
                  {!value && <option value="">Model default</option>}
                  {spec.enum.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      )}

      <p className={`small ${props.catalogError ? "error" : "muted"}`}>
        {props.catalogError ??
          (catalog
            ? `${catalog.chat.length} chat and ${catalog.image.length} image models run on Cloudflare credits · checked ${new Date(catalog.checkedAt * 1000).toLocaleTimeString()}.`
            : "Checking the model catalog…")}
      </p>

      <div className="actions">
        <button type="button" disabled={busy || !dirty} onClick={startReview}>
          Review changes
        </button>
        <button type="button" className="secondary" disabled={busy || !dirty} onClick={() => edit((next) => Object.assign(next, structuredClone({ chat: settings.chat, image: settings.image })))}>
          Discard draft
        </button>
        <span className="spacer" />
        <button type="button" className="secondary" disabled={busy} onClick={props.onRefreshModels}>
          Refresh models
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={props.onReload}>
          Reload saved
        </button>
      </div>
      {dirty && !review && <p className="muted small">Unsaved draft. Test runs below use it.</p>}

      {review && (
        <div className="review">
          <h3>{target === "live" ? "Review changes to the live bot" : "Review sandbox changes"}</h3>
          {review.changes.length ? (
            <table>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Saved</th>
                  <th>After save</th>
                </tr>
              </thead>
              <tbody>
                {review.changes.map((change) => (
                  <tr key={change.setting}>
                    <th>{change.setting.replace(/^image\.profiles\./, "image / ").replaceAll(".", " / ")}</th>
                    <td>
                      <pre>{show(change.before)}</pre>
                    </td>
                    <td>
                      <pre>{show(change.after)}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No changes to save.</p>
          )}
          {review.changes.length > 0 && (
            <div className="actions">
              <button type="button" className={target === "live" ? "danger" : ""} disabled={busy} onClick={save}>
                {target === "live" ? "Save to live bot" : "Save to sandbox"}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setReview(undefined)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
