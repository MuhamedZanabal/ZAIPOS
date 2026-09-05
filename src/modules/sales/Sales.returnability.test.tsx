import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const fixtures = [
  {
    id: "60000000-0000-0000-0000-000000000001",
    ticket_number: 101,
    total: 10,
    status: "completed",
    created_at: "2026-09-05T09:00:00Z",
    channel: "pos",
    sale_items: [],
    payments: [{ method: "cash", amount: 10 }],
  },
  {
    id: "60000000-0000-0000-0000-000000000002",
    ticket_number: 102,
    total: 10,
    status: "partially_refunded",
    created_at: "2026-09-05T09:05:00Z",
    channel: "pos",
    sale_items: [],
    payments: [{ method: "card", amount: 10 }],
  },
  {
    id: "60000000-0000-0000-0000-000000000003",
    ticket_number: 103,
    total: 10,
    status: "refunded",
    created_at: "2026-09-05T09:10:00Z",
    channel: "pos",
    sale_items: [],
    payments: [{ method: "qr", amount: 10 }],
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixtures }),
}));

vi.mock("@/hooks/useTenantContext", () => ({
  useTenantContext: () => ({ branchId: "20000000-0000-0000-0000-000000000001" }),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("./ReturnDialog", () => ({ ReturnDialog: () => null }));

import Sales from "./Sales";

describe("Sales return eligibility", () => {
  it("allows returns for completed and partially refunded sales, but not fully refunded sales", () => {
    render(<Sales />);

    const returnButtons = screen.getAllByRole("button", { name: "Return" });
    expect(returnButtons).toHaveLength(2);
    expect(screen.getByText("Partially refunded")).toBeInTheDocument();
    expect(screen.getByText("Refunded")).toBeInTheDocument();
  });
});
