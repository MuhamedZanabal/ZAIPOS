import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Link } from "react-router-dom";
import { formatCurrency } from "@/lib/format";
import {
  TrendingUp,
  Wallet,
  Package,
  Factory,
  ShoppingCart,
  BarChart3,
  Globe,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  qr: "BenefitPay",
  transfer: "Bank Transfer",
};
const CHANNEL_LABELS: Record<string, string> = {
  pos: "Physical POS",
  tables: "Tables",
  talabat: "Talabat",
  whatsapp: "WhatsApp",
  delivery: "Delivery",
  didi: "Didi",
  uber: "Uber",
};
const CHANNEL_COLORS = ["#1E63E6", "#5B95FF", "#9CC0FF", "#FFB54A", "#5CC8A1", "#9C7CFF"];

interface ReportingTrendPoint {
  bucket_start: string;
  sales_count: number;
  total_fils: number;
}
interface ReportingChannel {
  channel: string;
  sales_count: number;
  amount_fils: number;
}
interface ReportingPayment {
  method: string;
  amount_fils: number;
}
interface ReportingProduct {
  product_id: string;
  name: string;
  category: string;
  quantity: number;
  amount_fils: number;
}
interface ReportingSale {
  id: string;
  ticket_number: number | null;
  total_fils: number;
  created_at: string;
  channel: string;
}
interface ReportingSnapshot {
  branch_id: string;
  tenant_id: string;
  start_at: string;
  end_at: string;
  sales_count: number;
  total_sales_fils: number;
  average_ticket_fils: number;
  trend: ReportingTrendPoint[];
  channels: ReportingChannel[];
  payments: ReportingPayment[];
  top_products: ReportingProduct[];
  recent_sales: ReportingSale[];
  inventory: { total_skus: number; low_stock_count: number; out_of_stock_count: number };
  cash: { open: boolean; expected_fils: number };
  production_units: number;
  active_channels: string[];
}
interface DonutSeg { value: number; color: string; label: string; amount: string }

const filsToBhd = (fils: number | null | undefined) => (fils ?? 0) / 1000;

function AreaChart({ points }: { points: ReportingTrendPoint[] }) {
  const W = 480, H = 180, pl = 36, pr = 16, pt = 18, pb = 24;
  const iW = W - pl - pr, iH = H - pt - pb;
  const values = points.map((p) => p.total_fils);
  const max = Math.max(...values, 1);
  const n = Math.max(points.length, 1);
  const toX = (i: number) => pl + (n === 1 ? iW / 2 : (i / (n - 1)) * iW);
  const toY = (v: number) => pt + (1 - v / max) * iH;

  if (!points.length) {
    return <div className="h-meta text-center">No completed sales in this period</div>;
  }

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.total_fils).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${toX(points.length - 1).toFixed(1)} ${pt + iH} L ${toX(0).toFixed(1)} ${pt + iH} Z`;
  const last = points[points.length - 1];
  const lX = toX(points.length - 1), lY = toY(last.total_fils);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="g-chart-glow w-full">
      <defs>
        <linearGradient id="aFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2B7CFF" stopOpacity="0.30" /><stop offset="100%" stopColor="#2B7CFF" stopOpacity="0" /></linearGradient>
        <linearGradient id="aLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#7FA8FF" /><stop offset="100%" stopColor="#1E63E6" /></linearGradient>
      </defs>
      <path d={areaPath} fill="url(#aFill)" />
      <path d={linePath} fill="none" className="line" stroke="url(#aLine)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => <circle key={p.bucket_start} cx={toX(i)} cy={toY(p.total_fils)} r={i === points.length - 1 ? 4 : 2.3} fill="#fff" stroke="#2B7CFF" strokeWidth={i === points.length - 1 ? 2.5 : 1.5} />)}
      <g transform={`translate(${lX}, ${Math.max(14, lY - 24)})`}><rect x="-38" y="-13" width="76" height="20" rx="10" fill="#2B7CFF" /><text x="0" y="2" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">{formatCurrency(filsToBhd(last.total_fils))}</text></g>
    </svg>
  );
}

function Donut({ size = 160, segments, total }: { size?: number; segments: DonutSeg[]; total: string }) {
  const R = size / 2 - 14, C = 2 * Math.PI * R;
  const sum = segments.reduce((a, b) => a + b.value, 0);
  const cx = size / 2, cy = size / 2;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={R} stroke="rgba(43,124,255,0.08)" strokeWidth="18" fill="none" />
      {sum > 0 && segments.map((s, i) => {
        const dash = (s.value / sum) * C;
        const el = <circle key={s.label} cx={cx} cy={cy} r={R} stroke={s.color} strokeWidth="18" fill="none" strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset} transform={`rotate(-90 ${cx} ${cy})`} />;
        offset += dash;
        return el;
      })}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="12" fill="#7986A8">Total</text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="18" fontWeight="800" fill="#0E1F3D">{total}</text>
    </svg>
  );
}

function BarRow({ label, sub, pct, value }: { label: string; sub: string; pct: number; value: string }) {
  return <div className="flex flex-col gap-1.5"><div className="flex justify-between items-baseline"><span className="text-[13px] font-semibold text-ink-900">{label}</span><span className="g-num-14">{value}</span></div><div className="g-bar"><i ref={(el) => { if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`; }} /></div><span className="h-meta">{sub}</span></div>;
}

interface KPIProps { label: string; value: string; sub?: string; icon: React.ReactNode }
function KPICard({ label, value, sub, icon }: KPIProps) {
  return <div className="glass flex flex-col g-kpi"><div className="flex items-center justify-between gap-2.5"><div className="h-label g-val-12">{label}</div><div className="orb g-orb-38">{icon}</div></div><div className="h-num g-val-28">{value}</div>{sub && <div className="h-meta">{sub}</div>}</div>;
}

export default function Dashboard() {
  const { tenantId, branchId, branches } = useTenantContext();
  const branchName = branches.find((b) => b.id === branchId)?.name ?? "—";
  const range = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return { startAt: start.toISOString(), endAt: end.toISOString() };
  }, []);

  const { data: snapshot, isLoading, error } = useQuery({
    queryKey: ["branch-reporting-snapshot-v1", tenantId, branchId, range.startAt, range.endAt],
    enabled: !!tenantId && !!branchId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error: rpcError } = await (supabase as any).rpc("get_branch_reporting_snapshot_v1", {
        _branch_id: branchId,
        _start_at: range.startAt,
        _end_at: range.endAt,
      });
      if (rpcError) throw rpcError;
      return data as ReportingSnapshot;
    },
  });

  const totalSalesFils = snapshot?.total_sales_fils ?? 0;
  const channelSegs: DonutSeg[] = (snapshot?.channels ?? []).map((item, index) => ({
    value: item.amount_fils,
    color: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
    label: CHANNEL_LABELS[item.channel] ?? item.channel,
    amount: formatCurrency(filsToBhd(item.amount_fils)),
  }));
  const maxProductQty = Math.max(...(snapshot?.top_products ?? []).map((p) => Number(p.quantity)), 1);
  const inventory = snapshot?.inventory ?? { total_skus: 0, low_stock_count: 0, out_of_stock_count: 0 };
  const stockHealth = inventory.total_skus ? Math.round(((inventory.total_skus - inventory.low_stock_count - inventory.out_of_stock_count) / inventory.total_skus) * 100) : 100;

  if (error) {
    return <div className="glass g-panel-20"><div className="g-title-16">Reporting unavailable</div><p className="h-meta mt-2">The authoritative branch report could not be loaded. No fallback or fabricated values are shown.</p></div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5">
        <KPICard label="Period sales" value={isLoading ? "—" : formatCurrency(filsToBhd(totalSalesFils))} sub="Month to date" icon={<TrendingUp size={16} />} />
        <KPICard label="Completed sales" value={isLoading ? "—" : String(snapshot?.sales_count ?? 0)} sub="Month to date" icon={<ShoppingCart size={16} />} />
        <KPICard label="Average ticket" value={isLoading ? "—" : formatCurrency(filsToBhd(snapshot?.average_ticket_fils))} sub="Completed sales" icon={<Wallet size={16} />} />
        <KPICard label="Healthy stock" value={isLoading ? "—" : `${stockHealth}%`} sub="Current inventory" icon={<Package size={16} />} />
        <KPICard label="Production" value={isLoading ? "—" : String(snapshot?.production_units ?? 0)} sub="Units in period" icon={<Factory size={16} />} />
        <KPICard label="Active channels" value={isLoading ? "—" : String(snapshot?.active_channels?.length ?? 0)} sub="Tenant configuration" icon={<Globe size={16} />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr_1fr] gap-3.5 min-h-[300px]">
        <div className="glass flex flex-col gap-3.5 g-panel-20"><div><div className="g-title-16">Sales trend</div><div className="h-meta">Month to date · {branchName}</div></div><div className="flex-1 flex items-center justify-center min-w-0 overflow-hidden"><AreaChart points={snapshot?.trend ?? []} /></div><div><div className="g-num-26">{formatCurrency(filsToBhd(totalSalesFils))}</div><div className="h-meta">Authoritative completed-sale total</div></div></div>

        <div className="glass flex flex-col gap-3.5 g-panel-20"><div className="flex items-center justify-between"><div className="g-title-16">Top products</div><span className="g-pill g-pill-ghost g-pill-h28">This month</span></div><div className="flex flex-col gap-3 flex-1">{(snapshot?.top_products ?? []).map((r) => <BarRow key={r.product_id} label={r.name} sub={r.category} pct={(Number(r.quantity) / maxProductQty) * 100} value={Number(r.quantity).toLocaleString("en-BH")} />)}{!isLoading && !(snapshot?.top_products?.length) && <p className="h-meta text-center py-4">No product sales in this period</p>}</div><Link to="/products" className="g-link justify-between">View all products <ArrowUpRight size={12} /></Link></div>

        <div className="glass flex flex-col gap-3.5 g-panel-20"><div className="flex items-center justify-between"><div className="g-title-16">Sales channel</div><span className="g-pill g-pill-ghost g-pill-h28">This month</span></div><div className="flex items-center gap-4 flex-1"><Donut size={160} segments={channelSegs} total={formatCurrency(filsToBhd(totalSalesFils))} /><div className="flex flex-col gap-2.5 flex-1 min-w-0">{channelSegs.map((s) => <div key={s.label} className="flex items-center justify-between gap-1.5"><div className="flex items-center gap-2"><span className="g-dot-color" ref={(el) => { if (el) el.style.background = s.color; }} /><span className="text-[13px] font-semibold text-ink-900 truncate">{s.label}</span></div><div className="h-meta g-val-10 shrink-0">{s.amount}</div></div>)}</div></div><Link to="/reports" className="g-link justify-between">View details <ArrowUpRight size={12} /></Link></div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
        <div className="glass flex flex-col gap-3.5 g-panel"><div className="flex justify-between items-center"><div className="g-title-15">Inventory</div><Link to="/inventory" className="g-link g-val-12">View all</Link></div><div className="grid grid-cols-3 gap-2.5"><div><div className="h-meta mb-1">Total SKUs</div><div className="g-num-20">{inventory.total_skus}</div></div><div><div className="h-meta mb-1">Low stock</div><div className="g-num-20 text-g-warn">{inventory.low_stock_count}</div></div><div><div className="h-meta mb-1">Out of stock</div><div className="g-num-20 text-g-bad">{inventory.out_of_stock_count}</div></div></div><div><div className="flex justify-between mb-1.5"><span className="h-meta">Inventory health</span><span className="text-[12px] font-bold text-g-ok">{stockHealth}%</span></div><div className="g-bar"><i ref={(el) => { if (el) el.style.width = `${stockHealth}%`; }} /></div></div></div>

        <div className="glass flex flex-col gap-3 g-panel"><div className="flex justify-between items-center"><div className="g-title-15">Payments</div><Link to="/sales" className="g-link g-val-12">View all</Link></div><div className="flex flex-col gap-2">{(snapshot?.payments ?? []).slice(0, 4).map((m) => <div key={m.method} className="flex items-center justify-between"><div className="flex items-center gap-2.5"><Wallet size={16} className="text-ink-500" /><span className="text-[13px] font-semibold text-ink-900">{PAYMENT_METHOD_LABELS[m.method] ?? m.method}</span></div><span className="g-num-13">{formatCurrency(filsToBhd(m.amount_fils))}</span></div>)}{!isLoading && !(snapshot?.payments?.length) && <p className="h-meta text-center py-2">No payments in this period</p>}</div><div className="g-hairline" /><div className="flex justify-between items-center"><span className="text-[14px] font-bold text-ink-900">Sales total</span><span className="g-num-18">{formatCurrency(filsToBhd(totalSalesFils))}</span></div></div>

        <div className="glass flex flex-col gap-3 g-panel"><div className="flex justify-between items-center"><div className="g-title-15">Recent sales</div><span className="g-pill g-pill-ghost g-pill-h22">Persisted</span></div><div className="flex flex-col gap-2 flex-1">{(snapshot?.recent_sales ?? []).map((s) => <div key={s.id} className="flex items-center justify-between gap-2"><div className="min-w-0"><div className="text-[12px] font-semibold text-ink-900 truncate">#{s.ticket_number ?? s.id.slice(0, 6)}</div><div className="h-meta g-val-10">{new Date(s.created_at).toLocaleTimeString("en-BH", { hour: "2-digit", minute: "2-digit" })} · {CHANNEL_LABELS[s.channel] ?? s.channel}</div></div><span className="g-num-13 shrink-0">{formatCurrency(filsToBhd(s.total_fils))}</span></div>)}{!isLoading && !(snapshot?.recent_sales?.length) && <p className="h-meta text-center py-4">No completed sales in this period</p>}</div></div>

        <div className="glass flex flex-col gap-3 g-panel"><div className="flex justify-between items-center"><div className="g-title-15">Branches</div><Link to="/branches" className="g-link g-val-12">View all</Link></div><div className="flex flex-col gap-2">{branches.slice(0, 4).map((b) => <div key={b.id} className="flex items-center justify-between"><div className="flex items-center gap-2.5"><BarChart3 size={16} className="text-ink-500 shrink-0" /><span className="text-[13px] font-semibold text-ink-900 truncate max-w-[120px]">{b.name}</span></div><span className={cn("g-pill g-pill-h18", b.id === branchId ? "g-pill-ok" : "g-pill-ghost")}>{b.id === branchId ? "Selected" : "Active"}</span></div>)}{branches.length === 0 && <p className="h-meta text-center py-4">No branches</p>}</div><div className="g-hairline" /><div className="flex justify-between items-center"><span className="h-meta">Current register</span><span className="g-num-13">{snapshot?.cash?.open ? formatCurrency(filsToBhd(snapshot.cash.expected_fils)) : "Closed"}</span></div></div>
      </div>

      <p className="g-footer-note">ZAIPOS © 2026 — ZAIPOS Contributors · MIT</p>
    </div>
  );
}
