import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Bot, Save, Loader2, Trash2, Plus, BookOpen, Sparkles, RefreshCw, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

const DEFAULT_PROMPT = `You are the WhatsApp ordering assistant for a business in the Kingdom of Bahrain. Help customers place orders quickly, accurately, and clearly.

Rules:
- Respond in English unless the customer explicitly asks for another supported language.
- All prices are in Bahraini dinars (BHD) and must be shown with three decimal places.
- Use search_catalog before quoting a product, price, or availability.
- Use quote_order to show the order summary before creating an order.
- Use create_order only after the customer clearly confirms the order.
- Never invent products, prices, stock, tax treatment, delivery status, payment confirmation, or customer details.
- BenefitPay is a Bahrain payment method. Never claim a BenefitPay payment is settled unless verified payment evidence is available to the system.
- Use Bahrain +973 phone-number conventions when phone details are relevant.
- Treat Talabat as a Bahrain marketplace channel only through capabilities that are actually connected and documented.
- If the request cannot be completed reliably, use handoff_to_human.
- Keep all products requested by the customer in the same order unless they ask to split it.`;

const MODELS = [
  { value: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku" },
  { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "openai/gpt-4o", label: "GPT-4o" },
  { value: "google/gemini-flash-1.5", label: "Gemini 1.5 Flash" },
];

type KnowledgeDoc = {
  id: string;
  title: string;
  content: string;
  embedding: string | null;
  created_at: string;
};

export default function AiAgentSettings() {
  const { tenantId, branchId, branches } = useTenantContext();
  const qc = useQueryClient();
  const [selectedBranch, setSelectedBranch] = useState(branchId ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [aiModel, setAiModel] = useState("anthropic/claude-3.5-haiku");
  const [temperature, setTemperature] = useState("0.7");
  const [dailyRecommendation, setDailyRecommendation] = useState("");
  const [deliveryDelayMinutes, setDeliveryDelayMinutes] = useState("45");
  const [savingConfig, setSavingConfig] = useState(false);
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  const [savingDoc, setSavingDoc] = useState(false);
  const [embeddingId, setEmbeddingId] = useState<string | null>(null);

  useEffect(() => {
    if (branchId) setSelectedBranch(branchId);
  }, [branchId]);

  const { data: config, isLoading: loadingConfig } = useQuery({
    queryKey: ["ai-agent-config", selectedBranch],
    enabled: !!selectedBranch,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_channel_configs")
        .select("*")
        .eq("branch_id", selectedBranch)
        .eq("channel", "whatsapp")
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (config) {
      setSystemPrompt(config.system_prompt ?? "");
      setAiModel(config.ai_model ?? "anthropic/claude-3.5-haiku");
      setTemperature(String(config.temperature ?? 0.7));
      setDailyRecommendation(config.daily_recommendation ?? "");
      setDeliveryDelayMinutes(String(config.delivery_delay_minutes ?? 45));
    } else {
      setSystemPrompt("");
      setAiModel("anthropic/claude-3.5-haiku");
      setTemperature("0.7");
      setDailyRecommendation("");
      setDeliveryDelayMinutes("45");
    }
  }, [config]);

  const { data: docs = [], isLoading: loadingDocs } = useQuery<KnowledgeDoc[]>({
    queryKey: ["ai-knowledge-docs", selectedBranch],
    enabled: !!selectedBranch && !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_knowledge_docs")
        .select("id, title, content, embedding, created_at")
        .eq("branch_id", selectedBranch)
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as KnowledgeDoc[];
    },
  });

  const saveConfig = async () => {
    if (!selectedBranch || !tenantId) return;
    setSavingConfig(true);
    try {
      const parsedTemperature = Number.parseFloat(temperature);
      const parsedDelay = Number.parseInt(deliveryDelayMinutes, 10);
      const payload = {
        tenant_id: tenantId,
        branch_id: selectedBranch,
        channel: "whatsapp",
        system_prompt: systemPrompt.trim() || DEFAULT_PROMPT,
        ai_model: aiModel,
        temperature: Number.isFinite(parsedTemperature) ? Math.min(2, Math.max(0, parsedTemperature)) : 0.7,
        daily_recommendation: dailyRecommendation.trim() || null,
        delivery_delay_minutes: Number.isFinite(parsedDelay) && parsedDelay > 0 ? parsedDelay : 45,
        updated_at: new Date().toISOString(),
      };
      const { error } = config
        ? await supabase.from("ai_channel_configs").update(payload).eq("id", config.id)
        : await supabase.from("ai_channel_configs").insert(payload);
      if (error) throw error;
      toast.success("AI agent settings saved");
      qc.invalidateQueries({ queryKey: ["ai-agent-config"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingConfig(false);
    }
  };

  const generateEmbedding = async (docId: string) => {
    setEmbeddingId(docId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("No active session");
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/embed-knowledge-doc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ doc_id: docId, tenant_id: tenantId, branch_id: selectedBranch }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Embedding generation failed");
      toast.success(`Embedding generated${body.dims ? ` (${body.dims} dimensions)` : ""}`);
      qc.invalidateQueries({ queryKey: ["ai-knowledge-docs"] });
    } catch (e: any) {
      toast.error(`Could not generate embedding: ${e.message}`);
    } finally {
      setEmbeddingId(null);
    }
  };

  const addDoc = async () => {
    if (!newDocTitle.trim() || !newDocContent.trim()) return toast.error("Enter a title and content");
    if (!tenantId || !selectedBranch) return;
    setSavingDoc(true);
    try {
      const { data, error } = await supabase
        .from("ai_knowledge_docs")
        .insert({
          tenant_id: tenantId,
          branch_id: selectedBranch,
          title: newDocTitle.trim(),
          content: newDocContent.trim(),
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("Could not save the knowledge document");
      setAddDocOpen(false);
      setNewDocTitle("");
      setNewDocContent("");
      toast.success("Knowledge document saved");
      qc.invalidateQueries({ queryKey: ["ai-knowledge-docs"] });
      await generateEmbedding(data.id);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingDoc(false);
    }
  };

  const deleteDoc = async (id: string) => {
    const { error } = await supabase.from("ai_knowledge_docs").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Knowledge document deleted");
    qc.invalidateQueries({ queryKey: ["ai-knowledge-docs"] });
  };

  return (
    <div className="space-y-6">
      <div className="glass p-5 space-y-3">
        <div className="flex items-center gap-2 font-semibold">
          <Bot className="h-4 w-4 text-primary" /> WhatsApp AI Agent
        </div>
        <div className="space-y-1.5">
          <Label>Branch</Label>
          <Select value={selectedBranch} onValueChange={setSelectedBranch}>
            <SelectTrigger><SelectValue placeholder="Select branch…" /></SelectTrigger>
            <SelectContent>
              {(branches ?? []).map((branch: any) => (
                <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="glass p-5 space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="h-4 w-4 text-primary" /> Bahrain system prompt
          <Badge variant="secondary" className="ml-auto text-xs">
            {config?.system_prompt ? "Configured" : "Bahrain default"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          The default prompt enforces BHD pricing, Bahrain payment terminology, catalogue verification, and non-fabrication rules.
        </p>

        {loadingConfig ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <Textarea
              className="min-h-[260px] font-mono text-xs"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={DEFAULT_PROMPT}
            />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setSystemPrompt(DEFAULT_PROMPT)}>
                <RefreshCw className="h-4 w-4 mr-2" /> Use Bahrain default
              </Button>
            </div>
          </>
        )}
      </div>

      <div className="glass p-5 space-y-4">
        <div className="font-semibold">Model and operating behavior</div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>AI model</Label>
            <Select value={aiModel} onValueChange={setAiModel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODELS.map((model) => <SelectItem key={model.value} value={model.value}>{model.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Temperature</Label>
            <Input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Daily recommendation</Label>
            <Input
              value={dailyRecommendation}
              onChange={(e) => setDailyRecommendation(e.target.value)}
              placeholder="Optional product or operational recommendation for today"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Delivery estimate (minutes)</Label>
            <Input type="number" min="1" max="1440" value={deliveryDelayMinutes} onChange={(e) => setDeliveryDelayMinutes(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={saveConfig} disabled={savingConfig || !selectedBranch}>
            {savingConfig ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save AI settings
          </Button>
        </div>
      </div>

      <div className="glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <BookOpen className="h-4 w-4 text-primary" /> Knowledge base
          </div>
          <Button size="sm" onClick={() => setAddDocOpen(true)} disabled={!selectedBranch}>
            <Plus className="h-4 w-4 mr-2" /> Add document
          </Button>
        </div>

        {loadingDocs ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading knowledge documents…
          </div>
        ) : docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No knowledge documents are configured for this branch.</p>
        ) : (
          <div className="space-y-2">
            {docs.map((doc) => (
              <div key={doc.id} className="rounded-xl border p-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{doc.title}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2 mt-1">{doc.content}</div>
                  <div className="text-[11px] text-muted-foreground mt-2">
                    {doc.embedding ? "Embedding ready" : "Embedding not generated"}
                  </div>
                </div>
                {!doc.embedding && (
                  <Button variant="outline" size="sm" onClick={() => generateEmbedding(doc.id)} disabled={embeddingId === doc.id}>
                    {embeddingId === doc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => deleteDoc(doc.id)} title="Delete document">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={addDocOpen} onOpenChange={setAddDocOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add knowledge document</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={newDocTitle} onChange={(e) => setNewDocTitle(e.target.value)} placeholder="e.g. Delivery areas and fees" />
            </div>
            <div className="space-y-1.5">
              <Label>Content</Label>
              <Textarea className="min-h-[220px]" value={newDocContent} onChange={(e) => setNewDocContent(e.target.value)} placeholder="Enter verified business information for the agent to use." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDocOpen(false)}>Cancel</Button>
            <Button onClick={addDoc} disabled={savingDoc}>
              {savingDoc && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Save document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
