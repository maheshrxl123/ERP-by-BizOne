import {
  IconAlertTriangle,
  IconChartBar,
  IconCheck,
  IconCopy,
  IconLoader2,
  IconMessage,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconSend,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDateTime, formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  AiActionProposalRecord,
  AiConversationRecord,
  AiMessageRecord,
  AiPlaybookRecord,
} from '../../types/bizone';

type AiTab = 'chat' | 'analytics' | 'drafts' | 'playbooks' | 'approvals';

interface AiAssistantScreenProps {
  onOpenSettings?: () => void;
}

interface DuePartyOption {
  party_id: string;
  name: string;
  phone: string | null;
  to_receive: number;
  overdue_receivable: number;
}

export function AiAssistantScreen({ onOpenSettings }: AiAssistantScreenProps) {
  const { session, profile, language, showToast } = useApp();
  const isOwner = profile?.role === 'owner';
  const canSeeProfit = hasCapability(profile?.role, 'view_profit');

  const [tab, setTab] = useState<AiTab>('chat');
  const [chatLang, setChatLang] = useState<'en' | 'hi' | 'hinglish'>(
    language === 'hi' ? 'hi' : 'en'
  );
  const [hasProvider, setHasProvider] = useState<boolean>(false);
  const [hasBuiltInGemini, setHasBuiltInGemini] = useState<boolean>(false);
  const [checkingProvider, setCheckingProvider] = useState(true);

  const [conversations, setConversations] = useState<AiConversationRecord[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessageRecord[]>([]);
  const [promptInput, setPromptInput] = useState('');
  const [sending, setSending] = useState(false);

  const [analyticsText, setAnalyticsText] = useState<string | null>(null);
  const [analyticsMetrics, setAnalyticsMetrics] = useState<Record<string, unknown> | null>(null);
  const [runningAnalytics, setRunningAnalytics] = useState(false);

  const [dueParties, setDueParties] = useState<DuePartyOption[]>([]);
  const [draftKind, setDraftKind] = useState<'payment_reminder' | 'daily_brief'>('payment_reminder');
  const [draftPartyId, setDraftPartyId] = useState<string>('');
  const [draftLang, setDraftLang] = useState<'en' | 'hi' | 'hinglish'>(
    language === 'hi' ? 'hi' : 'hinglish'
  );
  const [draftText, setDraftText] = useState('');
  const [generatingDraft, setGeneratingDraft] = useState(false);

  const [playbooks, setPlaybooks] = useState<AiPlaybookRecord[]>([]);
  const [runningPlaybook, setRunningPlaybook] = useState<string | null>(null);

  const [proposals, setProposals] = useState<AiActionProposalRecord[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const loadAiStatusAndData = useCallback(async () => {
    if (!session?.access_token) return;
    setCheckingProvider(true);
    try {
      const [provRes, convRes, pbRes, propRes, partyRes] = await Promise.all([
        fetch('/api/ai/providers', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).then((r) => (r.ok ? r.json() : { hasConfiguredProvider: false, hasBuiltInGemini: false })),
        supabase
          .from('ai_conversations')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(20),
        supabase
          .from('ai_playbooks')
          .select('*')
          .order('playbook_key'),
        supabase
          .from('ai_action_proposals')
          .select(
            'id, conversation_id, playbook_key, tool_name, action_summary, before_snapshot, proposed_payload, consequences, payload_hash, expires_at, status, proposed_by_user_id, proposed_by_role, approved_by_user_id, rejection_reason, execution_result, created_at, decided_at'
          )
          .order('created_at', { ascending: false })
          .limit(40),
        supabase
          .from('party_balances')
          .select('party_id, name, phone, to_receive, overdue_receivable')
          .gt('to_receive', 0)
          .order('overdue_receivable', { ascending: false })
          .limit(50),
      ]);

      setHasProvider(Boolean(provRes?.hasConfiguredProvider));
      setHasBuiltInGemini(Boolean(provRes?.hasBuiltInGemini));
      const convRows = (convRes.data as AiConversationRecord[] | null) ?? [];
      setConversations(convRows);
      setPlaybooks((pbRes.data as AiPlaybookRecord[] | null) ?? []);
      setProposals((propRes.data as AiActionProposalRecord[] | null) ?? []);
      const partyRows = (partyRes.data as DuePartyOption[] | null) ?? [];
      setDueParties(partyRows);
      if (partyRows.length > 0) {
        setDraftPartyId((prev) => prev || partyRows[0].party_id);
      }
      if (convRows.length > 0) {
        setActiveConvId((prev) => prev || convRows[0].id);
      }
    } catch {
      // keep safe defaults
    } finally {
      setCheckingProvider(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    void loadAiStatusAndData();
  }, [loadAiStatusAndData]);

  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      return;
    }
    supabase
      .from('ai_messages')
      .select('*')
      .eq('conversation_id', activeConvId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setMessages((data as AiMessageRecord[] | null) ?? []);
      });
  }, [activeConvId]);

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token || !promptInput.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          message: promptInput.trim(),
          language: chatLang,
          conversationId: activeConvId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'AI request failed.');
      setPromptInput('');
      setActiveConvId(data.conversationId);
      await loadAiStatusAndData();
      const { data: msgRows } = await supabase
        .from('ai_messages')
        .select('*')
        .eq('conversation_id', data.conversationId)
        .order('created_at', { ascending: true });
      setMessages((msgRows as AiMessageRecord[] | null) ?? []);
      if (Array.isArray(data.proposals) && data.proposals.length > 0) {
        showToast(
          `Prepared ${data.proposals.length} draft proposal(s) awaiting Owner approval.`,
          'info'
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to send message.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    const { error } = await supabase.from('ai_conversations').delete().eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    if (activeConvId === id) {
      setActiveConvId(null);
      setMessages([]);
    }
    await loadAiStatusAndData();
  };

  const handleRunAnalytics = async () => {
    if (!session?.access_token) return;
    setRunningAnalytics(true);
    try {
      const res = await fetch('/api/ai/analytics', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Analytics failed.');
      setAnalyticsText(data.summary || '');
      setAnalyticsMetrics(data.metrics || null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Analytics failed.', 'error');
    } finally {
      setRunningAnalytics(false);
    }
  };

  const handleGenerateSmartDraft = async () => {
    if (!session?.access_token) return;
    if (draftKind === 'payment_reminder' && !draftPartyId) {
      showToast('Select a party with pending receivable first.', 'error');
      return;
    }
    setGeneratingDraft(true);
    try {
      const res = await fetch('/api/ai/smart-draft-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          kind: draftKind,
          language: draftLang,
          partyId: draftKind === 'payment_reminder' ? draftPartyId : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Unable to generate draft.');
      setDraftText(String(json.draftText || ''));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to generate draft.', 'error');
    } finally {
      setGeneratingDraft(false);
    }
  };

  const handleRunPlaybook = async (playbookKey: string) => {
    if (!session?.access_token) return;
    setRunningPlaybook(playbookKey);
    try {
      const res = await fetch('/api/ai/playbooks/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ playbookKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Playbook run failed.');
      const count = Array.isArray(data.proposalsCreated) ? data.proposalsCreated.length : 0;
      await loadAiStatusAndData();
      showToast(
        count > 0
          ? `Prepared ${count} draft proposal(s). Review in Approvals.`
          : 'Playbook checked: no pending items require action right now.',
        'success'
      );
      if (count > 0) setTab('approvals');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Playbook failed.', 'error');
    } finally {
      setRunningPlaybook(null);
    }
  };

  const handleTogglePlaybook = async (pb: AiPlaybookRecord) => {
    if (!isOwner) return;
    const { error } = await supabase
      .from('ai_playbooks')
      .update({ enabled: !pb.enabled })
      .eq('id', pb.id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAiStatusAndData();
  };

  const handleApproveProposal = async (id: string) => {
    if (!session?.access_token || !isOwner) return;
    setDecidingId(id);
    try {
      const res = await fetch(`/api/ai/proposals/${id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Approval failed.');
      showToast('Proposal approved and draft created.', 'success');
      await loadAiStatusAndData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Approval rejected.', 'error');
    } finally {
      setDecidingId(null);
    }
  };

  const handleRejectProposal = async (id: string) => {
    if (!session?.access_token || !isOwner) return;
    setDecidingId(id);
    try {
      const res = await fetch(`/api/ai/proposals/${id}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ reason: 'Rejected by Business Owner' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Rejection failed.');
      showToast('Proposal rejected.', 'info');
      await loadAiStatusAndData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to reject.', 'error');
    } finally {
      setDecidingId(null);
    }
  };

  const pendingCount = proposals.filter((p) => p.status === 'pending').length;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconRobot size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>
              {language === 'hi' ? 'बिज़वन एआई एजेंट (वैकल्पिक)' : 'BizOne AI Agent (Optional)'}
            </span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            {language === 'hi'
              ? 'केवल अधिकृत व्यवसाय डेटा पर आधारित प्रश्नोत्तर, विश्लेषण, स्मार्ट व्हाट्सएप ड्राफ्ट और ओनर-स्वीकृत प्रस्ताव।'
              : 'Ask questions in English, Hindi, or Hinglish, generate WhatsApp payment reminders & daily closing briefs, and review Owner-approved action proposals.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAiStatusAndData()}
          className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5 self-start hover:bg-[var(--surface-muted)] whitespace-nowrap shrink-0"
        >
          <IconRefresh size={15} stroke={2} />
          <span>Refresh</span>
        </button>
      </div>

      {!checkingProvider && !hasProvider && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <IconAlertTriangle size={20} stroke={2} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs sm:text-sm">
              <p className="font-semibold text-[var(--text)]">
                Optional AI Provider Key Not Configured
              </p>
              <p className="text-[var(--text-muted)] mt-0.5">
                Core billing, Khata, stock, and GST work without AI. To enable AI Chat & Insights, the Owner can configure OpenAI, Anthropic Claude, Gemini, OpenRouter, Grok, or a custom HTTPS endpoint in Settings → Integrations.
              </p>
            </div>
          </div>
          {isOwner && onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <IconSettings size={15} stroke={2} />
              <span>Configure AI Key</span>
            </button>
          )}
        </div>
      )}

      {/* Privacy & Role Guarantee Strip */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--text-muted)] flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2">
          <IconShieldCheck size={16} stroke={2} className="text-[var(--receive-text)] shrink-0" />
          <span>
            Role-masked tools active ({profile?.role || 'staff'}) ·{' '}
            {canSeeProfit
              ? 'Authorized for cost & profit summaries'
              : 'Purchase cost & profit margins masked for your role'}
            {hasBuiltInGemini ? ' · Built-in Gemini AI active' : ''}
          </span>
        </span>
        <span className="font-mono">Zero autonomous writes · SHA-256 signed proposals</span>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)] pb-2">
        {(
          [
            { key: 'chat', label: 'AI Chat', icon: IconSparkles },
            { key: 'analytics', label: 'Business Insights', icon: IconChartBar },
            { key: 'drafts', label: 'Smart Drafts', icon: IconMessage },
            { key: 'playbooks', label: 'Playbooks', icon: IconPlayerPlay },
            {
              key: 'approvals',
              label: pendingCount > 0 ? `Approvals (${pendingCount})` : 'Approvals',
              icon: IconShieldCheck,
            },
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

      {/* Chat Tab */}
      {tab === 'chat' && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <aside className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2">
            <button
              type="button"
              onClick={() => {
                setActiveConvId(null);
                setMessages([]);
              }}
              className="w-full h-10 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center justify-center gap-1.5"
            >
              <IconPlus size={15} stroke={2} />
              <span>New Conversation</span>
            </button>

            <div className="divide-y divide-[var(--border)] max-h-[380px] overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] py-4 text-center">
                  No saved chats yet.
                </p>
              ) : (
                conversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={`py-2 px-2 flex items-center justify-between gap-2 rounded-lg ${
                      activeConvId === conv.id ? 'bg-[var(--surface-muted)]' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveConvId(conv.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="text-xs font-medium truncate">{conv.title}</div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        {formatDateTime(conv.updated_at)}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteConversation(conv.id)}
                      aria-label="Delete conversation"
                      className="p-1 text-[var(--text-muted)] hover:text-[var(--give)]"
                    >
                      <IconTrash size={14} stroke={2} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>

          <section className="lg:col-span-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex flex-col min-h-[460px]">
            <div className="px-4 py-3 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {[
                  'What are today’s sales & cash collected?',
                  'Which customers have overdue Khata balances?',
                  'Aaj ka low stock aur reorder list dikhao',
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setPromptInput(q)}
                    className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <select
                value={chatLang}
                onChange={(e) => setChatLang(e.target.value as 'en' | 'hi' | 'hinglish')}
                aria-label="Reply language"
                className="h-8 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              >
                <option value="en">English</option>
                <option value="hi">हिन्दी</option>
                <option value="hinglish">Hinglish</option>
              </select>
            </div>

            <div className="flex-1 p-4 space-y-3 overflow-y-auto max-h-[380px]">
              {messages.length === 0 ? (
                <div className="py-12 text-center text-sm text-[var(--text-muted)]">
                  Ask a question about your sales, Khata dues, low stock, GST summary, or ask AI to draft an overdue reminder or reorder PO for Owner approval.
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-xl p-3.5 text-sm border ${
                      m.role === 'user'
                        ? 'ml-auto max-w-2xl bg-[var(--primary-soft)] border-[var(--primary)]/30'
                        : 'mr-auto max-w-3xl bg-[var(--surface-muted)] border-[var(--border)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--text-muted)] mb-1">
                      <span className="font-semibold uppercase">
                        {m.role === 'user' ? 'You' : `BizOne AI (${m.provider || 'provider'})`}
                      </span>
                      <span className="tabular-nums">{formatDateTime(m.created_at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                    {m.tools_used && m.tools_used.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)] font-mono">
                        Tools: {m.tools_used.join(', ')}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            <form
              onSubmit={handleSendChat}
              className="p-3 border-t border-[var(--border)] flex items-center gap-2"
            >
              <input
                type="text"
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                disabled={sending || !hasProvider}
                placeholder={
                  hasProvider
                    ? 'Ask about sales, Khata, stock, GST, or draft an action...'
                    : 'Configure an AI provider key in Settings → Integrations first'
                }
                className="flex-1 h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
              <button
                type="submit"
                disabled={sending || !hasProvider || !promptInput.trim()}
                className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <IconSend size={16} stroke={2} />
                <span>{sending ? 'Thinking...' : 'Ask AI'}</span>
              </button>
            </form>
          </section>
        </div>
      )}

      {/* Analytics Tab */}
      {tab === 'analytics' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">AI Business Insights & Anomaly Check</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Summarizes sales momentum, overdue dues, dead/slow stock, and role-permitted margins using allowlisted read tools only.
              </p>
            </div>
            <button
              type="button"
              disabled={runningAnalytics || !hasProvider}
              onClick={() => void handleRunAnalytics()}
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <IconSparkles size={15} stroke={2} />
              <span>{runningAnalytics ? 'Analyzing...' : 'Generate Insights'}</span>
            </button>
          </div>

          {analyticsText ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm whitespace-pre-wrap leading-relaxed">
              {analyticsText}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)] py-6 text-center">
              Click "Generate Insights" to analyze authorized workspace data.
            </p>
          )}

          {analyticsMetrics && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-[var(--border)]">
              <div className="rounded-lg border border-[var(--border)] p-3">
                <div className="text-xs text-[var(--text-muted)]">Overdue Parties Sampled</div>
                <div className="text-lg font-semibold tabular-nums mt-0.5">
                  {Array.isArray(analyticsMetrics.overdue_parties)
                    ? analyticsMetrics.overdue_parties.length
                    : 0}
                </div>
              </div>
              <div className="rounded-lg border border-[var(--border)] p-3">
                <div className="text-xs text-[var(--text-muted)]">Low / Out-of-Stock Alerts</div>
                <div className="text-lg font-semibold tabular-nums mt-0.5">
                  {Array.isArray(analyticsMetrics.stock_alerts)
                    ? analyticsMetrics.stock_alerts.length
                    : 0}
                </div>
              </div>
              <div className="rounded-lg border border-[var(--border)] p-3">
                <div className="text-xs text-[var(--text-muted)]">GST Summary Included</div>
                <div className="text-lg font-semibold mt-0.5">
                  {analyticsMetrics.gst_summary ? 'Yes' : 'Masked / Disabled'}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Smart Drafts Tab */}
      {tab === 'drafts' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">
                AI WhatsApp Reminders &amp; Daily Closing Brief
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Generate ready-to-send customer Khata payment reminders or an evening shop closing summary using authorized live figures.
              </p>
            </div>
            <button
              type="button"
              disabled={generatingDraft || !hasProvider}
              onClick={() => void handleGenerateSmartDraft()}
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {generatingDraft ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconSparkles size={15} stroke={2} />
              )}
              <span>{generatingDraft ? 'Drafting...' : 'Generate Draft'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Draft Type</label>
              <select
                value={draftKind}
                onChange={(e) =>
                  setDraftKind(e.target.value as 'payment_reminder' | 'daily_brief')
                }
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="payment_reminder">Customer Payment Reminder</option>
                <option value="daily_brief">Evening Daily Closing Brief</option>
              </select>
            </div>

            {draftKind === 'payment_reminder' && (
              <div>
                <label className="block text-xs font-medium mb-1">Customer with Dues</label>
                <select
                  value={draftPartyId}
                  onChange={(e) => setDraftPartyId(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {dueParties.length === 0 ? (
                    <option value="">No pending receivables</option>
                  ) : (
                    dueParties.map((p) => (
                      <option key={p.party_id} value={p.party_id}>
                        {p.name} ({formatINR(p.to_receive)})
                      </option>
                    ))
                  )}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1">Language</label>
              <select
                value={draftLang}
                onChange={(e) => setDraftLang(e.target.value as 'en' | 'hi' | 'hinglish')}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="hinglish">Hinglish (Shopkeeper Friendly)</option>
                <option value="hi">हिन्दी (Devanagari)</option>
                <option value="en">English (Formal)</option>
              </select>
            </div>
          </div>

          {draftText && (
            <div className="space-y-2.5 pt-2 border-t border-[var(--border)]">
              <textarea
                rows={5}
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                className="w-full p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-sm leading-relaxed"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(draftText);
                    showToast('Copied draft message to clipboard.', 'success');
                  }}
                  className="h-9 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <IconCopy size={14} stroke={2} />
                  <span>Copy Message</span>
                </button>
                {draftKind === 'payment_reminder' &&
                  (() => {
                    const selected = dueParties.find((p) => p.party_id === draftPartyId);
                    const digits = (selected?.phone || '').replace(/\D/g, '');
                    if (!digits) return null;
                    const intlDigits = digits.length === 10 ? `91${digits}` : digits;
                    return (
                      <a
                        href={`https://wa.me/${intlDigits}?text=${encodeURIComponent(draftText)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-9 px-3.5 rounded-lg bg-[var(--receive)] text-white text-xs font-semibold inline-flex items-center gap-1.5"
                      >
                        <IconMessage size={14} stroke={2} />
                        <span>Send via WhatsApp</span>
                      </a>
                    );
                  })()}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Playbooks Tab */}
      {tab === 'playbooks' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {playbooks.map((pb) => (
            <section
              key={pb.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 flex flex-col justify-between gap-4"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-semibold">
                    {language === 'hi' ? pb.title_hi : pb.title_en}
                  </h3>
                  <span className="text-xs text-[var(--text-muted)] font-mono shrink-0">
                    {pb.schedule_hint}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {language === 'hi' ? pb.description_hi : pb.description_en}
                </p>
                {pb.required_module && (
                  <p className="text-[11px] text-[var(--text-muted)] mt-2">
                    Requires module: <span className="font-mono">{pb.required_module}</span>
                  </p>
                )}
                {pb.last_run_at && (
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5 tabular-nums">
                    Last run: {formatDateTime(pb.last_run_at)}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-[var(--border)]">
                {isOwner ? (
                  <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pb.enabled}
                      onChange={() => void handleTogglePlaybook(pb)}
                      className="w-4 h-4 accent-[var(--primary-dark)]"
                    />
                    <span>{pb.enabled ? 'Enabled' : 'Disabled'}</span>
                  </label>
                ) : (
                  <span className="text-xs text-[var(--text-muted)]">
                    {pb.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                )}

                <button
                  type="button"
                  disabled={!pb.enabled || runningPlaybook === pb.playbook_key}
                  onClick={() => void handleRunPlaybook(pb.playbook_key)}
                  className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <IconPlayerPlay size={14} stroke={2} />
                  <span>
                    {runningPlaybook === pb.playbook_key ? 'Preparing...' : 'Prepare Drafts'}
                  </span>
                </button>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Approvals Tab */}
      {tab === 'approvals' && (
        <div className="space-y-4">
          {!isOwner && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs text-[var(--text-muted)]">
              View-only: Only the Business Owner can approve or reject AI action proposals.
            </div>
          )}

          {proposals.length === 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
              No AI action proposals yet. Run a Playbook or ask AI Chat to draft a reminder or reorder PO.
            </div>
          ) : (
            proposals.map((prop) => {
              const isPending = prop.status === 'pending';
              const amountPreview =
                typeof prop.proposed_payload?.amount === 'number'
                  ? formatINR(prop.proposed_payload.amount)
                  : null;
              return (
                <section
                  key={prop.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-mono text-[var(--text-muted)]">
                        {prop.tool_name} · Proposed by {prop.proposed_by_role} ·{' '}
                        {formatDateTime(prop.created_at)}
                      </div>
                      <h3 className="text-base font-semibold mt-0.5">
                        {prop.action_summary}
                        {amountPreview ? ` (${amountPreview})` : ''}
                      </h3>
                    </div>
                    <span
                      className={`text-xs font-semibold uppercase ${
                        prop.status === 'executed'
                          ? 'text-[var(--receive-text)]'
                          : prop.status === 'rejected' || prop.status === 'failed'
                            ? 'text-[var(--give)]'
                            : 'text-[var(--primary-dark)]'
                      }`}
                    >
                      {prop.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                      <div className="font-semibold mb-1">Proposed Draft Payload</div>
                      <pre className="font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(prop.proposed_payload, null, 2)}
                      </pre>
                    </div>
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 space-y-1">
                      <div className="font-semibold">Consequences & Verification</div>
                      {(prop.consequences || []).map((c, idx) => (
                        <p key={idx} className="text-[var(--text-muted)]">
                          • {c}
                        </p>
                      ))}
                      <p className="font-mono text-[11px] text-[var(--text-muted)] pt-1">
                        Expires: {formatDateTime(prop.expires_at)}
                      </p>
                    </div>
                  </div>

                  {isPending && isOwner && (
                    <div className="flex items-center gap-2 pt-2 border-t border-[var(--border)]">
                      <button
                        type="button"
                        disabled={decidingId === prop.id}
                        onClick={() => void handleApproveProposal(prop.id)}
                        className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                      >
                        <IconCheck size={15} stroke={2.5} />
                        <span>Approve & Create Draft</span>
                      </button>
                      <button
                        type="button"
                        disabled={decidingId === prop.id}
                        onClick={() => void handleRejectProposal(prop.id)}
                        className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--give)] inline-flex items-center gap-1.5 hover:bg-[var(--give-soft)]"
                      >
                        <IconX size={15} stroke={2} />
                        <span>Reject</span>
                      </button>
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
