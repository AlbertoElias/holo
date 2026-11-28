import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { PromptCapabilitiesDTO, PromptFinish, PromptJobDTO } from "@holoim/contracts";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { SignInForm } from "../auth/SignInForm";
import { useCurrentUser } from "../auth/useCurrentUser";
import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useFlatTarget } from "../chrome/useFlatScreen";
import { HologramCardCanvas } from "../feed/HologramCardCanvas";
import { createPortalStore } from "../portal/portalStore";
import {
  clearByokConfig,
  createPromptJob,
  fetchPromptCapabilities,
  fetchPromptPreviewBlobUrl,
  getPromptJob,
  loadByokConfig,
  publishPromptJob,
  revisePromptJob,
  saveByokConfig,
  type ByokConfig
} from "./api";

const STARTER_PROMPTS = [
  "Notice me, smile warmly, wave hello, and say 'Good to see you!'",
  "Shrug with a small smile and say 'Somehow that actually worked.'",
  "Pause, look up gently, nod, and say 'I missed you.'"
] as const;

const FINISH_OPTIONS: ReadonlyArray<{ value: PromptFinish; label: string }> = [
  { value: "clay", label: "Clay" },
  { value: "ink", label: "Ink" },
  { value: "light", label: "Light" }
];

const STATUS_LABEL: Record<PromptJobDTO["status"], string> = {
  queued: "Queued…",
  directing: "Directing your performance…",
  building: "Building 3D hologram and voice…",
  ready: "Preview ready",
  failed: "Generation failed"
};

export function CreatePage() {
  const navigate = useNavigate();
  const { user, isLoading } = useCurrentUser();
  const promptId = useId();
  const reviseId = useId();
  const providerId = useId();
  const apiKeyId = useId();
  const modelId = useId();

  const [capabilities, setCapabilities] = useState<PromptCapabilitiesDTO | null>(null);
  const [prompt, setPrompt] = useState("");
  const [finish, setFinish] = useState<PromptFinish>("clay");
  const [includeVoice, setIncludeVoice] = useState(true);
  const [byok, setByok] = useState<ByokConfig>(() => loadByokConfig());
  const [byokOpen, setByokOpen] = useState(false);

  const [job, setJob] = useState<PromptJobDTO | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [reviseNote, setReviseNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const portal = useMemo(() => createPortalStore(), []);
  const target = useFlatTarget();
  const soot = useMemo(() => ({ groundLuminance: 0.05 }), []);

  useEffect(() => {
    fetchPromptCapabilities()
      .then((caps) => {
        setCapabilities(caps);
        if (!caps.serverLlmAvailable) {
          setByokOpen(true);
        }
      })
      .catch(() => undefined);
  }, []);

  const jobId = job?.id ?? null;
  const jobStatus = job?.status ?? null;
  const jobPreviewUrl = job?.previewUrl ?? null;

  // Poll active job until it settles.
  useEffect(() => {
    if (!jobId || !jobStatus || jobStatus === "ready" || jobStatus === "failed") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getPromptJob(jobId)
        .then((next) => {
          if (!cancelled) setJob(next);
        })
        .catch(() => undefined);
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, jobStatus]);

  // Fetch authenticated preview GLB into a local Blob URL when ready.
  useEffect(() => {
    if (!jobId || jobStatus !== "ready" || !jobPreviewUrl) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    void fetchPromptPreviewBlobUrl(jobId)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setPreviewUrl(url);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load hologram preview.");
        }
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [jobId, jobStatus, jobPreviewUrl]);

  const isBusy = submitting || (job !== null && job.status !== "ready" && job.status !== "failed");

  function updateByok(patch: Partial<ByokConfig>) {
    const next = { ...byok, ...patch };
    setByok(next);
    saveByokConfig(next);
  }

  async function onGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (trimmed.length < 3) {
      setError("Describe what you want the hologram to do (at least 3 characters).");
      return;
    }
    setError(null);
    setSubmitting(true);
    setCaption(null);
    setHasAudio(false);
    try {
      const created = await createPromptJob({ prompt: trimmed, finish, includeVoice }, byok);
      setJob(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start generation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onRevise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!job || reviseNote.trim().length < 2) return;
    setError(null);
    setSubmitting(true);
    setCaption(null);
    try {
      const next = await revisePromptJob(job.id, { note: reviseNote.trim(), finish, includeVoice }, byok);
      setJob(next);
      setReviseNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revise hologram.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onPublish() {
    if (!job || job.status !== "ready" || publishing) return;
    setError(null);
    setPublishing(true);
    try {
      const published = await publishPromptJob(job.id, {
        ...(job.title ? { hologramName: job.title } : {}),
        quickLookEnabled: true
      });
      navigate(`/h/${published.id}?posted=1`, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish hologram.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="prompt-page" aria-label="Create a hologram from a prompt">
        <header className="prompt-header">
          <a className="prompt-back" href="/">
            {VIEWER_CONTROL_NAMES.backToFeed}
          </a>
          <Type variant="titlePhoneCard" as="h1">
            Create with AI
          </Type>
        </header>

        {isLoading ? null : !user ? (
          <SignInForm
            next="create"
            intro="Sign in once to generate private hologram previews and post the ones you like."
          />
        ) : (
          <>
            <form className="prompt-form" onSubmit={onGenerate}>
              <label className="upload-field" htmlFor={promptId}>
                <Type variant="byline">Describe your hologram</Type>
                <textarea
                  id={promptId}
                  className="upload-input prompt-textarea"
                  rows={3}
                  maxLength={500}
                  placeholder="A friend smiles warmly, waves hello, and says 'Good to see you!'"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  disabled={isBusy}
                />
              </label>

              <div className="prompt-chips" role="group" aria-label="Starter ideas">
                {STARTER_PROMPTS.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    className="prompt-chip"
                    onClick={() => setPrompt(idea)}
                    disabled={isBusy}
                  >
                    {idea}
                  </button>
                ))}
              </div>

              <div className="prompt-options">
                <div className="prompt-finish" role="group" aria-label="Avatar finish">
                  {FINISH_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="prompt-pill"
                      aria-pressed={finish === option.value}
                      onClick={() => setFinish(option.value)}
                      disabled={isBusy}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {capabilities?.voiceAvailable !== false ? (
                  <label className="upload-quicklook-toggle">
                    <Type variant="byline">Include voice</Type>
                    <input
                      className="upload-switch"
                      type="checkbox"
                      checked={includeVoice}
                      onChange={(event) => setIncludeVoice(event.target.checked)}
                      disabled={isBusy}
                    />
                  </label>
                ) : null}
              </div>

              <div className="prompt-byok">
                <button
                  type="button"
                  className="prompt-byok-toggle"
                  aria-expanded={byokOpen}
                  onClick={() => setByokOpen((open) => !open)}
                >
                  {byok.apiKey.trim()
                    ? `Using my ${byok.provider} key (saved only on this device)`
                    : "Use my own API key (BYOK)"}
                </button>

                {byokOpen ? (
                  <div className="prompt-byok-fields">
                    <label className="upload-field" htmlFor={providerId}>
                      <Type variant="byline">Provider</Type>
                      <select
                        id={providerId}
                        className="upload-input"
                        value={byok.provider}
                        onChange={(event) =>
                          updateByok({ provider: event.target.value as ByokConfig["provider"] })
                        }
                      >
                        <option value="anthropic">Anthropic (Claude Haiku — cheapest)</option>
                        <option value="openai">OpenAI (GPT-4o-mini)</option>
                        <option value="openrouter">OpenRouter</option>
                      </select>
                    </label>
                    <label className="upload-field" htmlFor={apiKeyId}>
                      <Type variant="byline">API key (stored only in your browser)</Type>
                      <input
                        id={apiKeyId}
                        className="upload-input"
                        type="password"
                        autoComplete="off"
                        placeholder="sk-..."
                        value={byok.apiKey}
                        onChange={(event) => updateByok({ apiKey: event.target.value })}
                      />
                    </label>
                    <label className="upload-field" htmlFor={modelId}>
                      <Type variant="byline">Model (optional override)</Type>
                      <input
                        id={modelId}
                        className="upload-input"
                        type="text"
                        placeholder="Leave blank for cheapest default"
                        value={byok.model}
                        onChange={(event) => updateByok({ model: event.target.value })}
                      />
                    </label>
                    {byok.apiKey ? (
                      <button
                        type="button"
                        className="prompt-byok-clear"
                        onClick={() => {
                          clearByokConfig();
                          setByok({ provider: "anthropic", apiKey: "", model: "" });
                        }}
                      >
                        Remove saved key
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="upload-actions">
                <GlyphControl
                  glyph={null}
                  showLabel
                  label={VIEWER_CONTROL_NAMES.generateHologram}
                  word={isBusy ? "Generating…" : "Generate hologram"}
                  disabled={isBusy}
                  onPress={() => {
                    const form = document.querySelector<HTMLFormElement>(".prompt-form");
                    form?.requestSubmit();
                  }}
                />
              </div>
            </form>

            {error ? (
              <p className="feed-error" role="alert">
                {error}
              </p>
            ) : null}

            {job ? (
              <section className="prompt-result" aria-label="Hologram preview">
                <div className="prompt-status" role="status">
                  <Type variant="byline">
                    {STATUS_LABEL[job.status]}
                    {job.title ? ` — ${job.title}` : ""}
                  </Type>
                  {job.status === "failed" && job.error ? (
                    <p className="feed-error" role="alert">
                      {job.error}
                    </p>
                  ) : null}
                </div>

                {job.status === "ready" && previewUrl ? (
                  <>
                    <div className="prompt-stage">
                      <HologramCardCanvas
                        modelUrl={previewUrl}
                        active
                        muted={muted}
                        onHasAudio={setHasAudio}
                        onCredits={() => undefined}
                        onCaption={setCaption}
                        colorAccurateMode={false}
                        portal={portal}
                        target={target}
                        reducedMotion={false}
                        seed={job.id}
                        soot={soot}
                        author={user.displayName}
                      />
                      {caption ? (
                        <div className="prompt-caption" aria-live="polite">
                          {caption}
                        </div>
                      ) : null}
                      {hasAudio ? (
                        <div className="prompt-stage-controls">
                          <GlyphControl
                            glyph={muted ? "soundOff" : "soundOn"}
                            label={muted ? VIEWER_CONTROL_NAMES.soundOn : VIEWER_CONTROL_NAMES.soundOff}
                            onPress={() => setMuted((m) => !m)}
                          />
                        </div>
                      ) : null}
                    </div>

                    <form className="prompt-revise" onSubmit={onRevise}>
                      <label className="upload-field" htmlFor={reviseId}>
                        <Type variant="byline">Tweak this hologram</Type>
                        <input
                          id={reviseId}
                          className="upload-input"
                          type="text"
                          maxLength={300}
                          placeholder="e.g. Make them look happier, or wave faster"
                          value={reviseNote}
                          onChange={(event) => setReviseNote(event.target.value)}
                          disabled={isBusy || publishing}
                        />
                      </label>
                      <div className="prompt-actions">
                        <GlyphControl
                          glyph={null}
                          showLabel
                          label="Revise hologram"
                          word="Revise"
                          disabled={isBusy || publishing || reviseNote.trim().length < 2}
                          onPress={() => {
                            const form = document.querySelector<HTMLFormElement>(".prompt-revise");
                            form?.requestSubmit();
                          }}
                        />
                        <GlyphControl
                          glyph="upload"
                          showLabel
                          label={VIEWER_CONTROL_NAMES.postHologram}
                          word={publishing ? "Posting…" : "Post to feed"}
                          disabled={isBusy || publishing}
                          onPress={() => void onPublish()}
                        />
                      </div>
                    </form>
                  </>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
