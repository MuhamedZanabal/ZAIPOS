import { useState } from "react";
import BusinessSettings from "./BusinessSettings";
import BranchesSettings from "./BranchesSettings";
import UsersSettings from "./UsersSettings";
import TablesSettings from "./TablesSettings";
import SalesChannelsSettings from "./SalesChannelsSettings";
import ReceiptSettings from "./ReceiptSettings";
import AppearanceSettings from "./AppearanceSettings";
import WhatsAppSettings from "./WhatsAppSettings";
import AiAgentSettings from "./AiAgentSettings";
import { DataManagement } from "./DataManagement";
import { SystemMaintenance } from "./SystemMaintenance";
import { cn } from "@/lib/utils";
import {
  Building2,
  GitBranch,
  UtensilsCrossed,
  Users,
  Globe,
  MessageCircle,
  Bot,
  Receipt,
  Palette,
  Database,
  Wrench,
  ChevronRight,
} from "lucide-react";

const TABS = [
  { id: "business", label: "My Business", icon: Building2 },
  { id: "branches", label: "Branches", icon: GitBranch },
  { id: "tables", label: "Tables", icon: UtensilsCrossed },
  { id: "users", label: "Users & Permissions", icon: Users },
  { id: "channels", label: "Sales Channels", icon: Globe },
  { id: "whatsapp", label: "WhatsApp AI", icon: MessageCircle },
  { id: "agent", label: "AI Agent", icon: Bot },
  { id: "receipt", label: "Receipt", icon: Receipt },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "data", label: "Data", icon: Database },
  { id: "operations", label: "Operations", icon: Wrench },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Settings() {
  const [active, setActive] = useState<TabId>("business");

  return (
    <div className="g-cfg-stage">
      <div className="glass g-cfg-nav-panel">
        <div className="h-display g-cfg-nav-title">Settings</div>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={cn("g-cfg-nav-item", isActive && "is-active")}
              onClick={() => setActive(tab.id)}
            >
              <Icon size={15} />
              <span className="flex-1 text-left">{tab.label}</span>
              {isActive && <ChevronRight size={12} />}
            </button>
          );
        })}
        <div className="g-cfg-nav-hint glass-thin">
          Changes are applied to this branch in real time.
        </div>
      </div>

      <div className="g-cfg-content">
        {active === "business" && <BusinessSettings />}
        {active === "branches" && <BranchesSettings />}
        {active === "tables" && <TablesSettings />}
        {active === "users" && <UsersSettings />}
        {active === "channels" && <SalesChannelsSettings />}
        {active === "whatsapp" && <WhatsAppSettings />}
        {active === "agent" && <AiAgentSettings />}
        {active === "receipt" && <ReceiptSettings />}
        {active === "appearance" && <AppearanceSettings />}
        {active === "data" && <DataManagement />}
        {active === "operations" && <SystemMaintenance />}
      </div>
    </div>
  );
}
