import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { FournisseurNotifications } from "./ui.tsx";
import "./styles.css";

const racine = document.getElementById("racine");
if (!racine) throw new Error("Élément #racine introuvable dans index.html");

createRoot(racine).render(
  <StrictMode>
    <FournisseurNotifications>
      <App />
    </FournisseurNotifications>
  </StrictMode>,
);
