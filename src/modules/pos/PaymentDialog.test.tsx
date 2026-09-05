import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentDialog } from "./PaymentDialog";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

describe("PaymentDialog split payments", () => {
  const onConfirm = vi.fn();

  beforeEach(() => {
    onConfirm.mockReset();
  });

  function renderDialog(total = 8.5) {
    render(
      <PaymentDialog
        open
        onOpenChange={vi.fn()}
        total={total}
        tenantId="10000000-0000-0000-0000-000000000001"
        submitting={false}
        onConfirm={onConfirm}
      />,
    );
  }

  function balanceValue(label: "Allocated" | "Remaining") {
    const labelNode = screen.getByText(label);
    const container = labelNode.parentElement;
    if (!container) throw new Error(`${label} balance container is missing`);
    return within(container);
  }

  it("shows exact allocated and remaining balances and prevents premature completion", () => {
    renderDialog();

    expect(balanceValue("Allocated").getByText("BHD 0.000")).toBeInTheDocument();
    expect(balanceValue("Remaining").getByText("BHD 8.500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /complete sale/i })).toBeDisabled();
  });

  it("adds BenefitPay then cash over-tender, shows change, and submits separate exact allocations", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "BenefitPay" }));
    const amountInput = screen.getByRole("spinbutton", { name: /payment amount/i });
    fireEvent.change(amountInput, { target: { value: "3.500" } });
    fireEvent.click(screen.getByRole("button", { name: /add benefitpay payment/i }));

    expect(screen.getByText("BenefitPay · BHD 3.500")).toBeInTheDocument();
    expect(balanceValue("Remaining").getByText("BHD 5.000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /complete sale/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /payment amount/i }), {
      target: { value: "10.000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add cash payment/i }));

    expect(screen.getByText("Cash · BHD 5.000")).toBeInTheDocument();
    expect(screen.getByText("Change · BHD 5.000")).toBeInTheDocument();
    expect(balanceValue("Allocated").getByText("BHD 8.500")).toBeInTheDocument();
    expect(balanceValue("Remaining").getByText("BHD 0.000")).toBeInTheDocument();

    const complete = screen.getByRole("button", { name: /complete sale/i });
    expect(complete).toBeEnabled();
    fireEvent.click(complete);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      [
        {
          method: "qr",
          amountFils: 3_500,
          tenderedFils: 3_500,
          changeFils: 0,
          reference: null,
        },
        {
          method: "cash",
          amountFils: 5_000,
          tenderedFils: 10_000,
          changeFils: 5_000,
          reference: null,
        },
      ],
      0,
      undefined,
      0,
    );
  });

  it("removing an allocation restores the exact remaining balance", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /payment amount/i }), {
      target: { value: "3.500" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add card payment/i }));

    expect(screen.getByText("Card · BHD 3.500")).toBeInTheDocument();
    expect(balanceValue("Remaining").getByText("BHD 5.000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /remove card payment/i }));

    expect(screen.queryByText("Card · BHD 3.500")).not.toBeInTheDocument();
    expect(balanceValue("Remaining").getByText("BHD 8.500")).toBeInTheDocument();
  });

  it("locks total-changing tip and coupon controls once a partial payment exists", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /payment amount/i }), {
      target: { value: "1.000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add card payment/i }));

    expect(screen.getByRole("button", { name: "5%" })).toBeDisabled();
    expect(screen.getByPlaceholderText("Enter code...")).toBeDisabled();
    expect(screen.getByText(/remove payments to edit tip or coupon/i)).toBeInTheDocument();
  });
});
