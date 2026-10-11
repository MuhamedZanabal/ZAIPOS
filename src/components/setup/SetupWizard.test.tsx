import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupWizard } from "./SetupWizard";
import { FIRST_IN_APP_STEP, initialWizardState, starterCatalog } from "@/lib/setupWizard";

describe("SetupWizard", () => {
  beforeEach(() => localStorage.clear());

  it("blocks Next until a type is picked, then creates the business from basics", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    render(<SetupWizard local onCreateBusiness={create} />);
    expect(screen.getByText("Step 1 of 6")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a business type");

    fireEvent.click(screen.getByRole("radio", { name: /supermarket/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("Business basics")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /create business/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Business name is required");
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Amwaj Market" } });
    fireEvent.change(screen.getByLabelText("Owner email"), { target: { value: "owner@amwaj.bh" } });
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "verysecret" } });
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("What kind of business is this?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(await screen.findByRole("button", { name: /create business/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].mode).toBe("SUPERMARKET");
    expect(create.mock.calls[0][0].catalog.items.some((i: { unit: string }) => i.unit === "kg")).toBe(true);
    // Draft saved for resume, without the password.
    expect(localStorage.getItem("zaipos.setupWizard.v1")).not.toContain("verysecret");
  });

  it("runs the in-app steps and finishes", async () => {
    const save = vi.fn(async (_step: number, state) => state);
    const finish = vi.fn().mockResolvedValue(undefined);
    const initial = { ...initialWizardState(), mode: "RESTAURANT" as const, step: FIRST_IN_APP_STEP, catalog: { useSamples: true, items: starterCatalog("RESTAURANT") } };
    render(<SetupWizard initial={initial} onSaveStep={save} onFinish={finish} />);
    expect(screen.getAllByTestId("starter-item").length).toBe(8);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("Payments and receipt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText(/Give each person their own login/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add kitchen/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Every staff member needs a login");
    fireEvent.click(screen.getByRole("button", { name: /remove staff member/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText(/ready for a first test sale/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start first test sale/i }));
    await waitFor(() => expect(finish).toHaveBeenCalled());
    expect(save).toHaveBeenCalledTimes(3);
  });
});
