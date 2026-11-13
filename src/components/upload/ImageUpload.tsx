import {
  IconArrowLeft,
  IconArrowRight,
  IconLoader2,
  IconPhoto,
  IconRefresh,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';

export interface UploadedImageItem {
  fileId: string;
  url: string;
  fileName: string;
  isPrimary?: boolean;
}

interface ImageUploadProps {
  label: string;
  purpose: 'avatar' | 'business_logo' | 'upi_qr' | 'item_image';
  multiple?: boolean;
  value: UploadedImageItem[];
  onChange: (next: UploadedImageItem[]) => void;
  onUploaded?: (items: UploadedImageItem[]) => Promise<void> | void;
  onRemoved?: (removedFileId?: string) => Promise<void> | void;
  deferDelete?: boolean;
  entityType?: string;
  entityId?: string;
  helperText?: string;
  maxFiles?: number;
}

async function compressImageFile(
  file: File
): Promise<{ base64: string; mimeType: 'image/webp' | 'image/jpeg' | 'image/png' }> {
  const maxDim = 1280;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable.'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const outMime =
          file.type === 'image/png'
            ? 'image/png'
            : file.type === 'image/webp'
              ? 'image/webp'
              : 'image/jpeg';
        const dataUrl = canvas.toDataURL(outMime, 0.84);
        resolve({ base64: dataUrl, mimeType: outMime });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function ImageUpload({
  label,
  purpose,
  multiple = false,
  value,
  onChange,
  onUploaded,
  onRemoved,
  deferDelete = false,
  entityType,
  entityId,
  helperText,
  maxFiles = 6,
}: ImageUploadProps) {
  const { session, getSignedUrl, showToast, t } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceIdxRef = useRef<number | null>(null);
  const attemptedHydrateRef = useRef<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Hydrate missing signed URLs once per fileId
  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      const missing = value.filter(
        (item) =>
          item.fileId && !item.url && !attemptedHydrateRef.current.has(item.fileId)
      );
      if (missing.length === 0) return;

      for (const item of missing) {
        attemptedHydrateRef.current.add(item.fileId);
      }

      const updated = await Promise.all(
        value.map(async (item) => {
          if (item.url) return item;
          const signed = await getSignedUrl(item.fileId);
          return signed ? { ...item, url: signed } : item;
        })
      );
      if (active) onChange(updated);
    };
    void hydrate();
    return () => {
      active = false;
    };
  }, [value, getSignedUrl, onChange]);

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !session?.access_token) return;
    setError(null);
    setUploading(true);
    setProgress(12);

    const replaceIndex = replaceIdxRef.current;
    replaceIdxRef.current = null;
    const isReplaceSingle = replaceIndex !== null && replaceIndex >= 0 && replaceIndex < value.length;
    const previousFileId = isReplaceSingle
      ? value[replaceIndex!]?.fileId
      : !multiple
        ? value[0]?.fileId
        : undefined;

    try {
      const filesToProcess = isReplaceSingle
        ? [fileList[0]]
        : multiple
          ? Array.from(fileList).slice(0, Math.max(1, maxFiles - value.length))
          : [fileList[0]];

      const nextList: UploadedImageItem[] =
        isReplaceSingle || multiple ? [...value] : [];

      for (let i = 0; i < filesToProcess.length; i++) {
        const raw = filesToProcess[i];
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(raw.type)) {
          throw new Error('Only JPEG, PNG, and WebP images are supported.');
        }
        if (raw.size > 5 * 1024 * 1024) {
          throw new Error('Image must be 5 MB or smaller.');
        }

        const compressed = await compressImageFile(raw);
        setProgress(Math.round(((i + 0.5) / filesToProcess.length) * 85));

        const targetOrder = isReplaceSingle ? replaceIndex! : nextList.length;
        const targetPrimary = isReplaceSingle
          ? Boolean(value[replaceIndex!]?.isPrimary)
          : nextList.length === 0;

        const res = await fetch('/api/files/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            fileName: raw.name,
            mimeType: compressed.mimeType,
            base64: compressed.base64,
            purpose,
            entityType,
            entityId,
            sortOrder: targetOrder,
            isPrimary: targetPrimary,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || 'Upload failed.');
        }

        const uploadedItem: UploadedImageItem = {
          fileId: data.file.id,
          url: data.file.signedUrl || compressed.base64,
          fileName: data.file.file_name,
          isPrimary: targetPrimary,
        };

        if (isReplaceSingle) {
          nextList[replaceIndex!] = uploadedItem;
        } else {
          nextList.push(uploadedItem);
        }
      }

      setProgress(100);
      if (onUploaded) {
        await onUploaded(nextList);
      }
      onChange(nextList);

      // Delete replaced file immediately unless parent defers cleanup until Save
      if (
        !deferDelete &&
        previousFileId &&
        !nextList.some((x) => x.fileId === previousFileId)
      ) {
        await fetch(`/api/files/${encodeURIComponent(previousFileId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).catch(() => undefined);
      }

      showToast('Image uploaded securely.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Image upload failed.';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(0), 400);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async (idx: number) => {
    const target = value[idx];
    const next = value.filter((_, i) => i !== idx);
    if (next.length > 0 && !next.some((item) => item.isPrimary)) {
      next[0] = { ...next[0], isPrimary: true };
    }
    setError(null);
    try {
      if (onRemoved) {
        await onRemoved(target?.fileId);
      }
      onChange(next);
      if (!deferDelete && target?.fileId && session?.access_token) {
        await fetch(`/api/files/${encodeURIComponent(target.fileId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to remove image.';
      setError(msg);
      showToast(msg, 'error');
    }
  };

  const handleSetPrimary = (idx: number) => {
    onChange(
      value.map((item, i) => ({
        ...item,
        isPrimary: i === idx,
      }))
    );
  };

  const handleMove = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= value.length) return;
    const copy = [...value];
    const [removed] = copy.splice(idx, 1);
    copy.splice(target, 0, removed);
    onChange(copy);
  };

  const triggerAdd = () => {
    replaceIdxRef.current = null;
    inputRef.current?.click();
  };

  const triggerReplace = (idx: number) => {
    replaceIdxRef.current = idx;
    inputRef.current?.click();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--text)]">{label}</span>
        {multiple && (
          <span className="text-xs text-[var(--text-muted)] tabular-nums">
            {value.length} / {maxFiles}
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple={multiple}
        onChange={(e) => handleFilesSelected(e.target.files)}
        className="hidden"
      />

      {uploading && (
        <div className="w-full h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
          <div
            className="h-full bg-[var(--primary)] transition-all duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {value.length === 0 ? (
        <button
          type="button"
          onClick={triggerAdd}
          disabled={uploading}
          className="w-full min-h-[96px] p-4 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--primary-soft)]/40 transition-colors flex flex-col items-center justify-center gap-2 text-center"
        >
          {uploading ? (
            <IconLoader2 size={22} stroke={2} className="animate-spin text-[var(--primary-dark)]" />
          ) : (
            <IconPhoto size={22} stroke={2} className="text-[var(--text-muted)]" />
          )}
          <span className="text-xs font-medium text-[var(--text)]">
            {uploading ? `Uploading ${progress}%` : t('common.uploadImage')}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            JPEG, PNG, or WebP · Max 5 MB
          </span>
        </button>
      ) : (
        <div className="space-y-2">
          <div className={multiple ? 'grid grid-cols-2 sm:grid-cols-3 gap-3' : 'flex items-center gap-4'}>
            {value.map((item, idx) => (
              <div
                key={item.fileId || idx}
                className={`relative rounded-xl border bg-[var(--surface)] overflow-hidden flex flex-col ${
                  item.isPrimary && multiple
                    ? 'border-[var(--primary)]'
                    : 'border-[var(--border)]'
                }`}
              >
                <div className={multiple ? 'h-28 w-full bg-[var(--surface-muted)] relative' : 'h-20 w-20 bg-[var(--surface-muted)] shrink-0'}>
                  {item.url ? (
                    <img
                      src={item.url}
                      alt={item.fileName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
                      <IconPhoto size={20} stroke={2} />
                    </div>
                  )}
                  {multiple && (
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/65 text-white text-[10px] font-medium tabular-nums">
                      #{idx + 1}{item.isPrimary ? ' · Primary' : ''}
                    </span>
                  )}
                </div>

                {multiple ? (
                  <div className="p-1.5 flex items-center justify-between gap-1 border-t border-[var(--border)]">
                    <button
                      type="button"
                      onClick={() => handleSetPrimary(idx)}
                      title="Set as primary image"
                      aria-label="Set as primary image"
                      className="p-1.5 rounded hover:bg-[var(--surface-muted)] text-[var(--primary-dark)]"
                    >
                      {item.isPrimary ? (
                        <IconStarFilled size={15} />
                      ) : (
                        <IconStar size={15} stroke={2} />
                      )}
                    </button>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => triggerReplace(idx)}
                        disabled={uploading}
                        title={t('common.replace')}
                        aria-label={t('common.replace')}
                        className="p-1.5 rounded hover:bg-[var(--surface-muted)] text-[var(--text-muted)]"
                      >
                        <IconUpload size={14} stroke={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(idx, -1)}
                        disabled={idx === 0}
                        aria-label="Move left"
                        className="p-1.5 rounded hover:bg-[var(--surface-muted)] disabled:opacity-30"
                      >
                        <IconArrowLeft size={14} stroke={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(idx, 1)}
                        disabled={idx === value.length - 1}
                        aria-label="Move right"
                        className="p-1.5 rounded hover:bg-[var(--surface-muted)] disabled:opacity-30"
                      >
                        <IconArrowRight size={14} stroke={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(idx)}
                        aria-label={t('common.remove')}
                        className="p-1.5 rounded hover:bg-[var(--give-soft)] text-[var(--give)]"
                      >
                        <IconTrash size={14} stroke={2} />
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

            {!multiple && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={triggerAdd}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)]"
                >
                  <IconUpload size={15} stroke={2} />
                  <span>{uploading ? `${progress}%` : t('common.replace')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(0)}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border)] text-[var(--give)] hover:bg-[var(--give-soft)]"
                >
                  <IconTrash size={15} stroke={2} />
                  <span>{t('common.remove')}</span>
                </button>
              </div>
            )}
          </div>

          {multiple && value.length < maxFiles && (
            <button
              type="button"
              onClick={triggerAdd}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)]"
            >
              <IconUpload size={15} stroke={2} />
              <span>{uploading ? `Uploading ${progress}%` : 'Add more images'}</span>
            </button>
          )}
        </div>
      )}

      {helperText && (
        <p className="text-xs text-[var(--text-muted)]">{helperText}</p>
      )}
      {error && (
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--give)]">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1 font-medium underline shrink-0"
          >
            <IconRefresh size={13} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
