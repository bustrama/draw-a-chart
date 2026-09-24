import { useEffect, useState } from 'react';
import { canShareFile, clipboardImageSupported, copyImage, downloadImage, isAppleTouchDevice, shareImage, takeSnapshot, type Snapshot } from '../app/screenshot';
import type { Workspace } from '../app/Workspace';
import { CameraIcon, CopyIcon, DownloadIcon, ShareIcon } from './icons';
import { Popover } from './Popover';

interface Props {
  readonly workspace: Workspace | null;
}

type Feedback = { kind: 'ok' | 'error'; text: string } | null;

export function ScreenshotButton({ workspace }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        title="Screenshot"
        aria-label="Screenshot"
        disabled={!workspace}
        onClick={() => setOpen((o) => !o)}
        data-testid="screenshot-button"
        className={`ui-control flex h-8 w-8 items-center justify-center rounded-md ${open ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'}`}
      >
        <CameraIcon width={18} height={18} />
      </button>
      {open && workspace && <ScreenshotPanel workspace={workspace} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ScreenshotPanel({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  // Capture immediately when the panel opens: this is exactly the view the user is looking at,
  // and having the PNG ready keeps the action taps synchronous (clipboard/share requirements).
  const [snapshot] = useState<Snapshot>(() => takeSnapshot(workspace));
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    snapshot.blob
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setFile(new File([blob], snapshot.filename, { type: 'image/png' }));
      })
      .catch((err: unknown) => setFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [snapshot]);

  const canCopy = clipboardImageSupported();
  const canShare = file !== null && canShareFile(file);
  const preferShare = isAppleTouchDevice();

  const onCopy = () => {
    // Synchronous call inside the tap handler (Safari requirement).
    copyImage(snapshot.blob)
      .then(() => setFeedback({ kind: 'ok', text: 'Copied to clipboard' }))
      .catch(() => setFeedback({ kind: 'error', text: canShare ? 'Clipboard blocked here — use Share → Copy.' : 'Clipboard blocked here — use Download.' }));
  };
  const onShare = () => {
    if (!file) return;
    shareImage(file, snapshot.title).catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setFeedback({ kind: 'error', text: 'Sharing failed.' });
    });
  };
  const onDownload = () => {
    void snapshot.blob.then((blob) => {
      downloadImage(blob, snapshot.filename);
      setFeedback({ kind: 'ok', text: 'Download started' });
    });
  };

  return (
    <Popover onClose={onClose} className="w-72" testId="screenshot-panel">
      <div className="mb-2 overflow-hidden rounded-md border border-ink-700 bg-ink-950">
        {previewUrl ? (
          <img src={previewUrl} alt="Chart screenshot preview" className="block h-auto max-h-[45vh] w-full object-contain" data-testid="screenshot-preview" />
        ) : (
          <div className="flex h-32 items-center justify-center text-xs text-ink-400">Rendering…</div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <ActionButton label="Copy" onClick={onCopy} disabled={!canCopy} testId="screenshot-copy">
          <CopyIcon width={18} height={18} />
        </ActionButton>
        <ActionButton label="Share" onClick={onShare} disabled={!canShare} emphasize={preferShare} testId="screenshot-share">
          <ShareIcon width={18} height={18} />
        </ActionButton>
        <ActionButton label="Download" onClick={onDownload} testId="screenshot-download">
          <DownloadIcon width={18} height={18} />
        </ActionButton>
      </div>
      {feedback && (
        <p className={`mt-2 text-xs ${feedback.kind === 'ok' ? 'text-up' : 'text-down'}`} role="status" data-testid="screenshot-feedback">
          {feedback.text}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-snug text-ink-400">Captures the visible chart with your drawings (no crosshair).</p>
    </Popover>
  );
}

function ActionButton(props: { label: string; onClick: () => void; disabled?: boolean; emphasize?: boolean; testId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props.testId}
      className={`ui-control flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] disabled:opacity-35 ${
        props.emphasize ? 'bg-ink-700 text-ink-100' : 'bg-ink-800 text-ink-200 hover:bg-ink-700'
      }`}
    >
      {props.children}
      {props.label}
    </button>
  );
}
