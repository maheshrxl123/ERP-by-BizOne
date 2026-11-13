export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function isValidGstin(value: string): boolean {
  if (!value) return true;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
    value.trim().toUpperCase()
  );
}

export function formatDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return '—';
  const normalized =
    /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate) ? `${isoOrDate}T00:00:00` : isoOrDate;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function buildUpiDeepLink(params: {
  upiId: string;
  businessName: string;
  amount?: number;
  note?: string;
}): string {
  const pa = params.upiId.trim();
  if (!pa) return '';
  const search = new URLSearchParams({
    pa,
    pn: params.businessName.trim() || 'BizOne Store',
    cu: 'INR',
  });
  if (params.amount && params.amount > 0) {
    search.set('am', params.amount.toFixed(2));
  }
  if (params.note?.trim()) {
    search.set('tn', params.note.trim().slice(0, 60));
  }
  return `upi://pay?${search.toString()}`;
}

export function buildDueReminderText(params: {
  lang: 'en' | 'hi';
  businessName: string;
  businessPhone?: string | null;
  upiId?: string | null;
  partyName: string;
  dueAmount: number;
  openRefs?: Array<{ referenceNo: string; remainingAmount: number; dueDate?: string | null }>;
}): string {
  const amtText = formatINR(params.dueAmount);
  const upiUrl = params.upiId
    ? buildUpiDeepLink({
        upiId: params.upiId,
        businessName: params.businessName,
        amount: params.dueAmount,
        note: `Due payment - ${params.partyName}`,
      })
    : '';
  const refsLines =
    params.openRefs && params.openRefs.length > 0
      ? params.openRefs
          .slice(0, 5)
          .map(
            (r) =>
              `• ${r.referenceNo}: ${formatINR(r.remainingAmount)}${
                r.dueDate ? ` (${params.lang === 'hi' ? 'देय' : 'Due'} ${formatDate(r.dueDate)})` : ''
              }`
          )
          .join('\n')
      : '';

  if (params.lang === 'hi') {
    const lines = [
      `नमस्ते ${params.partyName} जी,`,
      `${params.businessName} में आपका कुल बकाया ${amtText} है।`,
    ];
    if (refsLines) {
      lines.push('', 'बकाया विवरण:', refsLines);
    }
    if (upiUrl) {
      lines.push('', `यूपीआई से भुगतान करें (${params.upiId}):`, upiUrl);
    }
    lines.push(
      '',
      `कृपया शीघ्र भुगतान करें। धन्यवाद!${params.businessPhone ? `\nसंपर्क: ${params.businessPhone}` : ''}`
    );
    return lines.join('\n');
  }

  const lines = [
    `Dear ${params.partyName},`,
    `Gentle payment reminder from ${params.businessName}: your current due balance is ${amtText}.`,
  ];
  if (refsLines) {
    lines.push('', 'Pending references:', refsLines);
  }
  if (upiUrl) {
    lines.push('', `Pay via UPI (${params.upiId}):`, upiUrl);
  }
  lines.push(
    '',
    `Thank you for your business.${params.businessPhone ? `\nContact: ${params.businessPhone}` : ''}`
  );
  return lines.join('\n');
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

