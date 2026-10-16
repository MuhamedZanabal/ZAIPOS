import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageToggle } from "./LanguageToggle";
import { useLanguageStore } from "@/i18n";

describe("LanguageToggle", () => {
  it("switches to Arabic RTL and back, persisting the choice", () => {
    act(() => useLanguageStore.getState().setLanguage("en"));
    render(<LanguageToggle />);
    fireEvent.click(screen.getByTestId("language-toggle"));
    expect(document.documentElement.dir).toBe("rtl");
    expect(JSON.parse(localStorage.getItem("zaipos.language")!).state.language).toBe("ar");
    expect(screen.getByTestId("language-toggle")).toHaveTextContent("English");
    fireEvent.click(screen.getByTestId("language-toggle"));
    expect(document.documentElement.dir).toBe("ltr");
  });
});
