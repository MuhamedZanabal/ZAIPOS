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
import {
  Bot, Save, Loader2, Trash2, Plus, BookOpen, Sparkles, RefreshCw, AlertCircle, CalendarClock,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

const DEFAULT_PROMPT = `You are this business's WhatsApp ordering assistant. Your job is to help customers place orders quickly and clearly.

Reglas:
- Always respond in English, briefly and in a friendly tone.
- Use search_catalog to find products before quoting or confirming.
- Use quote_order to show the order summary before creating it.
- Use create_order only when the customer confirms (says "yes", "confirm", "ready", "go ahead", "ok", or similar).
- Si no puedes resolver algo, usa handoff_to_human.
- Prices are in Colombian pesos (COP).
- Do not invent products or prices; always check the catalog.
- If the customer requests several products, add them all to the same order.`;

const MODELS = [
  { value: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku (fast, economical)" },
  { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet (smarter)" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "openai/gpt-4o", label: "GPT-4o" },
  { value: "google/gemini-flash-1.5", label: "Gemini 1.5 Flash" },
];

// ─── Types ───────────────────────────────────────────────────────────────────
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

  // Agent prompt state
  const [systemPrompt, setSystemPrompt] = useState("");
  const [aiModel, setAiModel] = useState("anthropic/claude-3.5-haiku");
  const [temperature, setTemperature] = useState("0.7");
  const [dailyRecommendation, setDailyRecommendation] = useState("");
  const [deliveryDelayMinutes, setDeliveryDelayMinutes] = useState("45");
  const [savingConfig, setSavingConfig] = useState(false);

  // Doc state
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  const [savingDoc, setSavingDoc] = useState(false);
  const [embeddingId, setEmbeddingId] = useState<string | null>(null);

  useEffect(() => {
    if (branchId) setSelectedBranch(branchId);
  }, [branchId]);

  // Load AI config
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
      setTemperature(String(config.temperature ?? "0.7"));
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

  // Load knowledge docs
  const { data: docs, isLoading: loadingDocs } = useQuery<KnowledgeDoc[]>({
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

  // ── Save agent config ────────────────────────────────────────
  const saveConfig = async () => {
    if (!selectedBranch || !tenantId) return;
    setSavingConfig(true);
    try {
      const payload = {
        tenant_id: tenantId,
        branch_id: selectedBranch,
        channel: "whatsapp",
        system_prompt: systemPrompt.trim() || null,
        ai_model: aiModel,
        temperature: parseFloat(temperature),
        daily_recommendation: dailyRecommendation.trim() || null,
        delivery_delay_minutes: parseInt(deliveryDelayMinutes) || 45,
        updated_at: new Date().toISOString(),
      };
      const { error } = config
        ? await supabase.from("ai_channel_configs").update(payload).eq("id", config.id)
        : await supabase.from("ai_channel_configs").insert(payload);
      if (error) throw error;
      toast.success("Agent settings saved");
      qc.invalidateQueries({ queryKey: ["ai-agent-config"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingConfig(false);
    }
  };

  // ── Add knowledge document ───────────────────────────────────
  const addDoc = async () => {
    if (!newDocTitle.trim() || !newDocContent.trim()) return toast.error("Enter a title and content");
    if (!tenantId || !selectedBranch) return;
    setSavingDoc(true);
    try {
      // Insert doc without embedding first
      const { data: inserted, error: insErr } = await supabase
        .from("ai_knowledge_docs")
        .insert({
          tenant_id: tenantId,
          branch_id: selectedBranch,
          title: newDocTitle.trim(),
          content: newDocContent.trim(),
        })
        .select("id")
        .single();
      if (insErr || !inserted) throw insErr ?? new Error("Could not save the document");

      toast.success("Document saved. Generating embedding…");
      setAddDocOpen(false);
      setNewDocTitle("");
      setNewDocContent("");
      qc.invalidateQueries({ queryKey: ["ai-knowledge-docs"] });

      // Trigger embedding generation
      setEmbeddingId(inserted.id);
      await generateEmbedding(inserted.id);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingDoc(false);
    }
  };

  const generateEmbedding = async (docId: string) => {
    setEmbeddingId(docId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/embed-knowledge-doc`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ doc_id: docId, tenant_id: tenantId, branch_id: selectedBranch }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Embedding failed");
      toast.success(`Embedding generated (${body.dims} dims)`);
      qc.invalidateQueries({ queryKey: ["ai-knowledge-docs"] });
    } catch (e: any) {
      toast.error(`Error generating embedding: ${e.message}`);
    } finally {
      setEmbeddingId(null);
    }
  };

  const deleteDoc = async (id: string) => {
    const { error } = await supabase.from("ai_knowledge_docs").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Document deleted");
    qc.invalidateQueries({ queryKey: ["ai-knowledge-docs"] });
  };

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Branch selector */}
      <div className="glass p-5 space-y-3">
        <div className="flex items-center gap-2 font-semibold">
          <Bot className="h-4 w-4 text-primary" />
          Agente IA WhatsApp
        </div>
        <div className="space-y-1.5">
          <Label>Branch</Label>
          <Select value={selectedBranch} onValueChange={setSelectedBranch}>
            <SelectTrigger>
              <SelectValue placeholder="Select branch…" />
            </SelectTrigger>
            <SelectContent>
              {(branches ?? []).map((b: any) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* System Prompt */}
      <div className="glass p-5 space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          System Prompt
          {config?.system_prompt && (
            <Badge variant="secondary" className="ml-auto text-xs">Personalizado</Badge>
          )}
          {!config?.system_prompt && (
            <Badge variant="outline" className="ml-auto text-xs">Usando prompt por defecto</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Tell the agent how it should behave with your customers. If left blank, the standard prompt will be used.
        </p>

        {loadingConfig ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Instrucciones del agente</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => setSystemPrompt(DEFAULT_PROMPT)}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Restaurar defecto
                </Button>
              </div>
              <Textarea
                rows={12}
                placeholder={DEFAULT_PROMPT}
                value={systemPrompt}
                onChange={e => setSystemPrompt(e.target.value)}
                className="font-mono text-sm resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Modelo IA</Label>
                <Select value={aiModel} onValueChange={setAiModel}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODELS.map(m => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Temperatura (creatividad)</Label>
                <Input
                  type="number"
                  min="0" max="1" step="0.1"
                  value={temperature}
                  onChange={e => setTemperature(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">0 = preciso · 1 = creativo</p>
              </div>
            </div>

            <Button onClick={saveConfig} disabled={savingConfig}>
              {savingConfig ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Save settings
            </Button>
          </div>
        )}
      </div>

      {/* Daily Context Injection */}
      <div className="glass p-5 space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <CalendarClock className="h-4 w-4 text-primary" />
          Contexto Diario
        </div>
        <p className="text-xs text-muted-foreground">
          This information is injected automatically into every conversation. The agent uses it to respond with current daily information.
        </p>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Recommendation of the day</Label>
            <Textarea
              rows={3}
              placeholder="e.g. Today we have freshly baked ham and cheese croissants at $8,500. Perfect for breakfast!"
              value={dailyRecommendation}
              onChange={e => setDailyRecommendation(e.target.value)}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              The agent will mention it proactively when relevant. Update it each day.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Delivery lead time (minutes)</Label>
            <Input
              type="number"
              min="1"
              max="180"
              value={deliveryDelayMinutes}
              onChange={e => setDeliveryDelayMinutes(e.target.value)}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              The agent will tell the customer this time when confirming the order.
            </p>
          </div>

          <div className="rounded-md bg-muted/40 border px-3 py-2 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Current date and time</p>
            <p className="text-xs text-muted-foreground">
              Automatically injected into every message — no setup required.
            </p>
          </div>

          <Button onClick={saveConfig} disabled={savingConfig}>
            {savingConfig ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save daily context
          </Button>
        </div>
      </div>

      {/* Knowledge Base */}
      <div className="glass p-5 space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <BookOpen className="h-4 w-4 text-primary" />
          Base de Conocimiento (RAG)
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {docs?.length ?? 0} document{docs?.length !== 1 ? "s" : ""}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Add documents (policies, extended menu, FAQs, schedules…). The agent will consult
          the most relevant context automatically before responding.
        </p>

        {loadingDocs ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
          </div>
        ) : (
          <div className="space-y-2">
            {(docs ?? []).map(doc => (
              <div
                key={doc.id}
                className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{doc.title}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{doc.content}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    {doc.embedding ? (
                      <Badge variant="secondary" className="text-[10px] h-4">Embedding ✓</Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px] h-4">
                        <AlertCircle className="h-2.5 w-2.5 mr-1" />No embedding
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(doc.created_at).toLocaleDateString("es-CO")}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {!doc.embedding && (
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      title="Generate embedding"
                      disabled={embeddingId === doc.id}
                      onClick={() => generateEmbedding(doc.id)}
                    >
                      {embeddingId === doc.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Sparkles className="h-3 w-3" />}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title="Delete document"
                    onClick={() => deleteDoc(doc.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}

            <Button variant="outline" className="w-full" onClick={() => setAddDocOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add knowledge document
            </Button>
          </div>
        )}
      </div>

      {/* Add doc dialog */}
      <Dialog open={addDocOpen} onOpenChange={setAddDocOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New knowledge document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                placeholder="e.g. Delivery Policy, Special Drinks Menu, Hours…"
                value={newDocTitle}
                onChange={e => setNewDocTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Contenido</Label>
              <Textarea
                rows={12}
                placeholder="Write or paste the document content here. The agent will use it as a reference when relevant to the conversation."
                value={newDocContent}
                onChange={e => setNewDocContent(e.target.value)}
                className="font-mono text-sm resize-none"
              />
              <p className="text-xs text-muted-foreground">
                {newDocContent.length} characters · An embedding will be generated automatically.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDocOpen(false)}>Cancel</Button>
            <Button onClick={addDoc} disabled={savingDoc}>
              {savingDoc ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Save document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
