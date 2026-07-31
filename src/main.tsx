import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Ride from "./Ride";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ride />
  </StrictMode>,
);
