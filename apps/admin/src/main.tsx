import "./styles.css";
// First of the scripts: zod's eval probe is off before any schema is built (ADR-025 §3).
import "./jitless.ts";
import { mount } from "./root.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
mount(root);
