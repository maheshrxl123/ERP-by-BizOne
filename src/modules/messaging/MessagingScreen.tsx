import {
  IconBrandWhatsapp,
  IconMail,
  IconMessage,
  IconRefresh,
  IconSend,
  IconSettings,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDateTime } from '../../core/format';
import { erpFetch } from '../../core/erpFetch';
import { supabase } from '../../core/supabase';
import type { MessageLogRecord, MessageTemplateRecord } from '../../types/decorbiz';

type MessagingTab = 'compose' | 'templates' | 'logs';

interface MessagingScreenProps {
  onOpenSettings?: () => void;
}

export function MessagingScreen({ onOpenSettings }: MessagingScreenProps) {
  const { business, profile, session, language, isModuleEnabled, showToast } = useApp();
  const isOwner = profile?.role === 'owner';
  const emailNotifEnabled = isModuleEnabled('email_notifications');

  const [tab, setTab] = useState<MessagingTab>('compose');
  const [templates, setTemplates] = useState<MessageTemplateRecord[]>([]);
  const [logs, setLogs] = useState<MessageLogRecord[]>([]);
  const [sending, setSending] = useState(false);

  const [channel, setChannel] = useState<'whatsapp' | 'sms' | 'email'>('whatsapp');
  const [templateKey, setTemplateKey] = useState('due_reminder');
  const [recipient, setRecipient] = useState('');
  const [partyName, setPartyName] = useState('');
  const [amount, setAmount] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [customBody, setCustomBody] = useState('');

  const loadAll = useCallback(async () => {
    const [tplRes, logRes] = await Promise.all([
      supabase.from('message_templates').select('*').order('template_key'),
      supabase.from('message_logs').select('*').order('created_at', { ascending: false }).limit(50),
    ]);
    if (!tplRes.error && tplRes.data) setTemplates(tplRes.data as MessageTemplateRecord[]);
    if (!logRes.error && logRes.data) setLogs(logRes.data as MessageLogRecord[]);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!emailNotifEnabled && channel === 'email') {
      setChannel('whatsapp');
    }
  }, [emailNotifEnabled, channel]);

  const visibleTemplates = useMemo(
    () => (emailNotifEnabled ? templates : templates.filter((t) => t.channel !== 'email')),
    [templates, emailNotifEnabled]
  );

  const activeTemplate = useMemo(
    () => templates.find((t) => t.template_key === templateKey) || templates[0] || null,
    [templates, templateKey]
  );

  const renderedPreview = useMemo(() => {
    if (customBody.trim()) return customBody;
    const raw = activeTemplate
      ? language === 'hi'
        ? activeTemplate.body_hi
        : activeTemplate.body_en
      : '';
    return raw
      .replace(/\{\{party_name\}\}/g, partyName.trim() || 'Customer')
      .replace(/\{\{business_name\}\}/g, business?.name || 'DecorBiz Store')
      .replace(/\{\{amount\}\}/g, amount.trim() ? `₹${amount.trim()}` : '₹0.00')
      .replace(/\{\{bill_number\}\}/g, billNumber.trim() || 'INV-0001')
      .replace(/\{\{upi_link\}\}/g, business?.upi_id ? `upi://pay?pa=${business.upi_id}` : 'Store Counter');
  }, [activeTemplate, customBody, language, partyName, business, amount, billNumber]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token || !recipient.trim() || !renderedPreview.trim()) return;
    setSending(true);
    try {
      const res = await erpFetch('/api/erp/messaging/send', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          recipient: recipient.trim(),
          templateKey,
          body: renderedPreview.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Dispatch failed.');
      showToast(
        data.log?.status === 'sent'
          ? 'Message dispatched via provider.'
          : 'Saved in delivery log as queued draft (configure SMTP/WhatsApp gateway in Settings → Integrations for live push).',
        data.log?.status === 'sent' ? 'success' : 'info'
      );
      setRecipient('');
      setCustomBody('');
      await loadAll();
      setTab('logs');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to send message.', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconMessage size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>
              {emailNotifEnabled
                ? 'Customer Messaging (WhatsApp, SMS & Email)'
                : 'Customer Messaging (WhatsApp & SMS)'}
            </span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Send invoice links and Khata reminders with EN/HI templates using the Owner’s optional provider gateway.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isOwner && onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5"
            >
              <IconSettings size={14} stroke={2} />
              <span>Gateway Settings</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadAll()}
            className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1"
          >
            <IconRefresh size={14} stroke={2} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)] pb-2">
        {(
          [
            { key: 'compose', label: 'Compose & Send', icon: IconSend },
            { key: 'templates', label: 'Templates', icon: IconBrandWhatsapp },
            { key: 'logs', label: `Delivery Logs (${logs.length})`, icon: IconMail },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`h-10 px-4 rounded-lg text-sm font-medium inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
                tab === item.key
                  ? 'bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              <Icon size={16} stroke={2} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Compose */}
      {tab === 'compose' && (
        <form
          onSubmit={handleSend}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Channel
              </label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as 'whatsapp' | 'sms' | 'email')}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
                {emailNotifEnabled && <option value="email">Email</option>}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Template
              </label>
              <select
                value={templateKey}
                onChange={(e) => setTemplateKey(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {visibleTemplates.map((t) => (
                  <option key={t.id} value={t.template_key}>
                    {t.name} ({t.channel})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Recipient Phone or Email
              </label>
              <input
                type="text"
                required
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={channel === 'email' ? 'customer@example.com' : '+919876543210'}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
              placeholder="Party Name (for {{party_name}})"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount ₹ (for {{amount}})"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
            />
            <input
              type="text"
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              placeholder="Bill # (for {{bill_number}})"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Message Preview (or type custom message)
            </label>
            <textarea
              rows={4}
              value={customBody || renderedPreview}
              onChange={(e) => setCustomBody(e.target.value)}
              className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-sm"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={sending}
              className="h-10 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
            >
              <IconSend size={16} stroke={2} />
              <span>{sending ? 'Sending...' : 'Send / Queue Message'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Templates */}
      {tab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((tpl) => (
            <section
              key={tpl.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-2 text-sm"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{tpl.name}</h3>
                <span className="text-xs font-mono uppercase text-[var(--text-muted)]">
                  {tpl.channel}
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)]">{tpl.body_en}</p>
              <p className="text-xs text-[var(--text-muted)] pt-1 border-t border-[var(--border)]">
                {tpl.body_hi}
              </p>
            </section>
          ))}
        </div>
      )}

      {/* Logs */}
      {tab === 'logs' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          {logs.length === 0 ? (
            <div className="p-6 text-sm text-[var(--text-muted)]">No messages logged yet.</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="p-4 flex flex-wrap items-start justify-between gap-3 text-sm">
                <div className="max-w-2xl">
                  <div className="font-semibold">
                    [{log.channel.toUpperCase()}] {log.recipient}
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1 whitespace-pre-wrap">
                    {log.rendered_body}
                  </p>
                  {log.error_message && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      {log.error_message}
                    </p>
                  )}
                </div>
                <div className="text-right text-xs tabular-nums">
                  <div
                    className={`font-semibold uppercase ${
                      log.status === 'sent'
                        ? 'text-[var(--receive-text)]'
                        : log.status === 'failed'
                          ? 'text-[var(--give)]'
                          : 'text-[var(--primary-dark)]'
                    }`}
                  >
                    {log.status}
                  </div>
                  <div className="text-[var(--text-muted)] mt-0.5">
                    {formatDateTime(log.created_at)}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}
