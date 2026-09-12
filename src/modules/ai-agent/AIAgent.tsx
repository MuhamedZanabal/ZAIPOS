import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ClipboardCheck, Database, SearchCheck, ShieldCheck, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { formatCurrency } from "@/lib/format";

interface AiReportingFact {
  sales_count: number;
  total_sales_fils: number;
  average_ticket_fils: number;
  inventory?: {
    total_skus: number;
    low_stock_count: number;
    out_of_stock_count: number;
  };
  cash?: { open: boolean; expected_fils: number };
}

interface AiReadContext {
  mode: "read_only";
  question: string;
  fact: AiReportingFact;
  scope: {
    tenant_id: string;
    branch_id: string;
    start_at: string;
    end_at: string;
  };
  evidence: {
    source_type: string;
    source_ids: string[];
    generated_at: string;
    money_unit: "fils";
    currency: "BHD";
    authoritative: boolean;
  };
  limitations: string[];
}

interface AiActionRequest {
  id: string;
  branch_id: string;
  requested_by: string;
  action_type: string;
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const filsToBhd = (fils: number | null | undefined) => (fils ?? 0) / 1000;

export default function AIAgent() {
  const { tenantId, branchId, branches } = useTenantContext();
  const branchName = branches.find((branch) => branch.id === branchId)?.name ?? "Selected branch";
  const range = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return { startAt: start.toISOString(), endAt: end.toISOString() };
  }, []);
  const [question, setQuestion] = useState("What were sales and stock conditions this month?");
  const [result, setResult] = useState<AiReadContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionRequests, setActionRequests] = useState<AiActionRequest[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const reviewOperationIds = useRef<Record<string, string>>({});

  const loadActionRequests = useCallback(async () => {
    if (!branchId) {
      setActionRequests([]);
      return;
    }

    setQueueLoading(true);
    setQueueError(null);
    try {
      const { data, error: queueReadError } = await (supabase as any)
        .from("ai_action_requests")
        .select("id,branch_id,requested_by,action_type,payload,evidence,status,reviewed_by,review_reason,reviewed_at,created_at")
        .eq("branch_id", branchId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (queueReadError) throw queueReadError;
      setActionRequests((data ?? []) as AiActionRequest[]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The approval queue could not be loaded.";
      setQueueError(message);
      setActionRequests([]);
    } finally {
      setQueueLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void loadActionRequests();
  }, [loadActionRequests]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = question.trim();
    if (!normalized || !branchId || !tenantId) return;

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data, error: rpcError } = await (supabase as any).rpc("ai_read_reporting_context_v1", {
        p_branch_id: branchId,
        p_start_at: range.startAt,
        p_end_at: range.endAt,
        p_question: normalized,
      });
      if (rpcError) throw rpcError;
      setResult(data as AiReadContext);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The authoritative AI evidence query failed.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function reviewAction(request: AiActionRequest, approve: boolean) {
    const reason = (reviewReasons[request.id] ?? "").trim();
    if (!reason) {
      setQueueError("A human review reason is required before approval or rejection.");
      return;
    }

    const operationKey = `${request.id}:${approve ? "approve" : "reject"}:${reason}`;
    if (!reviewOperationIds.current[operationKey]) {
      reviewOperationIds.current[operationKey] = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    setReviewingId(request.id);
    setQueueError(null);
    try {
      const { error: reviewError } = await (supabase as any).rpc("review_ai_action_v1", {
        p_request_id: request.id,
        p_approve: approve,
        p_reason: reason,
        p_operation_id: reviewOperationIds.current[operationKey],
      });
      if (reviewError) throw reviewError;
      await loadActionRequests();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The server-authoritative review failed.";
      setQueueError(message);
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="glass space-y-4 p-6">
        <div className="flex items-center gap-3">
          <div className="orb grid h-11 w-11 place-items-center">
            <ShieldCheck className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="h-display text-xl">ZAIPOS AI</h1>
            <p className="h-meta">Source-backed read-only intelligence</p>
          </div>
          <span className="pill pill-ok ml-auto">READ ONLY</span>
        </div>

        <p className="text-sm leading-6 text-muted-foreground">
          Ask about the selected branch's month-to-date sales, inventory and register state. Facts come from the
          server-authorized reporting boundary and retain exact BHD fils. No AI business-state mutation tools are active.
        </p>

        <form className="space-y-3" onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="zaipos-ai-question">Question</label>
          <textarea
            id="zaipos-ai-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={1000}
            rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            placeholder="What were sales and stock conditions this month?"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {branchName} · {new Date(range.startAt).toLocaleDateString("en-BH")} to {new Date(range.endAt).toLocaleDateString("en-BH")}
            </div>
            <button
              type="submit"
              disabled={loading || !branchId || !tenantId || !question.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {loading ? "Querying authoritative data…" : "Query source-backed facts"}
            </button>
          </div>
        </form>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Source query unavailable. No fallback or fabricated values are shown. {error}
          </div>
        )}
      </div>

      {result && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="glass space-y-2 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><SearchCheck className="h-4 w-4 text-primary" />Fact</div>
              <div className="text-2xl font-bold">{formatCurrency(filsToBhd(result.fact.total_sales_fils))}</div>
              <p className="text-sm text-muted-foreground">Completed sales: {result.fact.sales_count} · Average ticket {formatCurrency(filsToBhd(result.fact.average_ticket_fils))}</p>
            </div>
            <div className="glass space-y-2 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><Database className="h-4 w-4 text-primary" />Inventory</div>
              <div className="text-2xl font-bold">{result.fact.inventory?.total_skus ?? 0} SKUs</div>
              <p className="text-sm text-muted-foreground">Low stock {result.fact.inventory?.low_stock_count ?? 0} · Out of stock {result.fact.inventory?.out_of_stock_count ?? 0}</p>
            </div>
            <div className="glass space-y-2 p-5">
              <div className="text-sm font-semibold">Register</div>
              <div className="text-2xl font-bold">{result.fact.cash?.open ? formatCurrency(filsToBhd(result.fact.cash.expected_fils)) : "Closed"}</div>
              <p className="text-sm text-muted-foreground">Expected cash from the authoritative open-session snapshot.</p>
            </div>
          </div>

          <div className="glass-thin space-y-3 p-5 text-sm">
            <div className="font-semibold">Evidence</div>
            <div className="grid gap-2 text-muted-foreground md:grid-cols-2">
              <div>Source: {result.evidence.source_type}</div>
              <div>Generated: {new Date(result.evidence.generated_at).toLocaleString("en-BH")}</div>
              <div>Branch: {result.scope.branch_id}</div>
              <div>Tenant: {result.scope.tenant_id}</div>
              <div>Money authority: {result.evidence.currency} integer {result.evidence.money_unit}</div>
              <div>Persisted sale references: {result.evidence.source_ids.length}</div>
            </div>
            {result.evidence.source_ids.length > 0 && (
              <div className="break-all text-xs text-muted-foreground">Source IDs: {result.evidence.source_ids.join(", ")}</div>
            )}
          </div>
        </>
      )}

      <section className="glass space-y-4 p-6" aria-labelledby="ai-review-queue-title">
        <div className="flex flex-wrap items-center gap-3">
          <div className="orb grid h-10 w-10 place-items-center"><ClipboardCheck className="h-5 w-5" /></div>
          <div>
            <h2 id="ai-review-queue-title" className="text-lg font-semibold">Human action review queue</h2>
            <p className="text-xs text-muted-foreground">Approval records human consent only. It never executes the proposed business action.</p>
          </div>
          <span className="pill ml-auto">HUMAN GATE</span>
        </div>

        {queueError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{queueError}</div>
        )}

        {queueLoading ? (
          <div className="py-6 text-sm text-muted-foreground">Loading branch approval queue…</div>
        ) : actionRequests.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
            No AI action requests are visible for {branchName}. No request is fabricated locally.
          </div>
        ) : (
          <div className="space-y-3">
            {actionRequests.map((request) => (
              <article key={request.id} className="rounded-xl border border-border bg-background/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{request.action_type}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Requested {new Date(request.created_at).toLocaleString("en-BH")} · ID {request.id}
                    </div>
                  </div>
                  <span className={`pill ${request.status === "approved" ? "pill-ok" : request.status === "rejected" ? "pill-danger" : ""}`}>
                    {request.status}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-border p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Immutable payload</div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(request.payload, null, 2)}</pre>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supporting evidence</div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(request.evidence, null, 2)}</pre>
                  </div>
                </div>

                {request.status === "pending" ? (
                  <div className="mt-4 space-y-3">
                    <label className="block text-xs font-semibold" htmlFor={`review-reason-${request.id}`}>Human review reason</label>
                    <textarea
                      id={`review-reason-${request.id}`}
                      rows={2}
                      maxLength={1000}
                      value={reviewReasons[request.id] ?? ""}
                      onChange={(event) => setReviewReasons((current) => ({ ...current, [request.id]: event.target.value }))}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      placeholder="Record why this request should be approved or rejected"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={reviewingId === request.id || !(reviewReasons[request.id] ?? "").trim()}
                        onClick={() => void reviewAction(request, true)}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-4 w-4" /> Approve
                      </button>
                      <button
                        type="button"
                        disabled={reviewingId === request.id || !(reviewReasons[request.id] ?? "").trim()}
                        onClick={() => void reviewAction(request, false)}
                        className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-semibold text-destructive disabled:opacity-50"
                      >
                        <XCircle className="h-4 w-4" /> Reject
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">Server authorization enforces manager authority and forbids self-review.</p>
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg border border-border p-3 text-sm">
                    <div className="font-medium">Review recorded</div>
                    <div className="mt-1 text-muted-foreground">{request.review_reason || "No rationale supplied"}</div>
                    {request.reviewed_at && <div className="mt-1 text-xs text-muted-foreground">{new Date(request.reviewed_at).toLocaleString("en-BH")}</div>}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="glass-thin p-4 text-xs leading-5 text-muted-foreground">
        Read-only intelligence plus a human approval control plane only. Approval records a reviewed state but cannot create or alter sales,
        payments, inventory, prices, refunds, orders, supplier/customer balances, cash sessions or permissions. No autonomous execution path exists.
      </div>
    </div>
  );
}
