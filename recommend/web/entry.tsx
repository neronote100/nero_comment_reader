import React from "react";
import { createRoot } from "react-dom/client";
import Home, { setLibraryApiBase } from "./app/page";

export function mountLibrary(host: HTMLElement, apiBase: string) {
  if (host.shadowRoot) return;
  setLibraryApiBase(apiBase);
  host.replaceChildren();
  const shadow = host.attachShadow({ mode: "open" });
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./library.css", import.meta.url).href;
  const root = document.createElement("div");
  root.className = "library-root";
  shadow.append(css, root);
  createRoot(root).render(<Home />);
}
