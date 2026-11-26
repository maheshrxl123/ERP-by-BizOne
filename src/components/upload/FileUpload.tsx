import { IconFileText, IconLoader2, IconTrash, IconUpload } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { erpFetch } from '../../core/erpFetch';

export interface UploadedFileItem {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  signedUrl?: string | null;
}

interface FileUploadProps {
  label: string;
  purpose?: 'attachment';
  value: UploadedFileItem | null;
  onChange: (next: UploadedFileItem | null) => void;
  helperText?: string;
}

export function FileUpload({
  label,
  purpose = 'attachment',
  value,
  onChange,
  helperText,
}: FileUploadProps) {
  const { session, showToast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (file: File | undefined) => {
    if (!file || !session?.access_token) return;
    setError(null);

    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ];
    if (!allowed.includes(file.type)) {
      setError('Only PDF, JPEG, PNG, and WebP attachments are permitted.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Attachment must be 5 MB or smaller.');
      return;
    }

    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });

      const res = await erpFetch('/api/erp/files/upload', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          base64,
          purpose,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Upload failed.');

      onChange({
        fileId: data.file.id,
        fileName: data.file.file_name,
        mimeType: data.file.mime_type,
        sizeBytes: data.file.size_bytes,
        signedUrl: data.file.signedUrl,
      });
      showToast('Attachment uploaded.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Attachment upload failed.';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDelete = async () => {
    if (value?.fileId && session?.access_token) {
      await erpFetch(`/api/erp/files/${encodeURIComponent(value.fileId)}`, session.access_token, {
        method: 'DELETE',
      }).catch((err) => {
        console.warn('Failed to delete uploaded attachment:', err);
      });
    }
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-[var(--text)]">
        {label}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        onChange={(e) => handleSelect(e.target.files?.[0])}
        className="hidden"
      />
      {!value ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium text-[var(--text)]"
        >
          {uploading ? (
            <IconLoader2 size={16} stroke={2} className="animate-spin" />
          ) : (
            <IconUpload size={16} stroke={2} />
          )}
          <span>{uploading ? 'Uploading...' : 'Attach PDF or Image'}</span>
        </button>
      ) : (
        <div className="p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <IconFileText size={18} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-[var(--text)] truncate">
                {value.fileName}
              </p>
              <p className="text-xs text-[var(--text-muted)] tabular-nums">
                {(value.sizeBytes / 1024).toFixed(1)} KB
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Remove attachment"
            className="p-1.5 rounded text-[var(--give)] hover:bg-[var(--give-soft)]"
          >
            <IconTrash size={16} stroke={2} />
          </button>
        </div>
      )}
      {helperText && (
        <p className="text-xs text-[var(--text-muted)]">{helperText}</p>
      )}
      {error && <p className="text-xs text-[var(--give)]">{error}</p>}
    </div>
  );
}
